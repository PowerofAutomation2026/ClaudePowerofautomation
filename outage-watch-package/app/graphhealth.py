"""Optional 'green dashboard' divergence detector (stdlib only).

Reads Microsoft's own Service Health through Microsoft Graph (app-only, permission
ServiceHealth.Read.All) and compares it with what our probes see. When our probes see trouble
but Microsoft still reports the service as operational, that is a DIVERGENCE.

IMPORTANT: this adapter has only been tested against a local mock of the Graph API. It has NOT
been verified against the real Microsoft Graph. The service-name mapping below is a best guess
and is configurable ("map" in the config). The adapter itself needs Entra sign-in and Graph, so
during a sign-in outage it will report "unknown", which is never treated as "Microsoft says healthy".

Config ("service_health"): {"tenant_env": "OW_TENANT_ID", "client_id_env": "OW_CLIENT_ID",
  "client_secret_env": "OW_CLIENT_SECRET", "poll_s": 300, "map": {"exchange": "Exchange Online"}}
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request

DEFAULT_MAP = {            # our probe name -> Graph healthOverview "service" display name (UNVERIFIED guesses)
    "exchange": "Exchange Online", "outlook-web": "Exchange Online", "teams": "Microsoft Teams",
    "sharepoint-online": "SharePoint Online", "onedrive-business": "OneDrive for Business", "auth": "Microsoft Entra",
    "exchange-365": "Exchange Online", "teams-admin": "Microsoft Teams", "entra-portal": "Microsoft Entra",
    "forms": "Microsoft Forms", "planner": "Planner", "viva-engage": "Microsoft Viva", "power-bi": "Power BI",
    "power-apps-maker": "Power Apps", "power-automate": "Power Automate", "security-portal": "Microsoft Defender XDR",
    "purview": "Microsoft Purview",
    "intune": "Microsoft Intune", "m365-portal": "Microsoft 365 suite", "admin-center": "Microsoft 365 suite",
    "power-platform": "Power Apps", "m365-copilot": "Microsoft Copilot (Microsoft 365)",
}
HEALTHY = "serviceoperational"
TROUBLE = ("warning", "suspect", "down")


def validate(cfg):
    if not isinstance(cfg, dict):
        raise ValueError("service_health must be an object")
    for k in ("tenant_env", "client_id_env", "client_secret_env"):
        if not (isinstance(cfg.get(k), str) and cfg[k].replace("_", "").isalnum()):
            raise ValueError(f"service_health.{k} must be the NAME of an environment variable")
    for k in ("tenant", "client_id", "client_secret", "secret", "token"):
        if k in cfg:
            raise ValueError(f"service_health.{k}: secrets are not allowed in the config file")
    if "map" in cfg and not (isinstance(cfg["map"], dict) and all(isinstance(a, str) and isinstance(b, str) for a, b in cfg["map"].items())):
        raise ValueError("service_health.map must be {probe name: Microsoft service name}")
    if type(cfg.get("poll_s", 300)) not in (int, float) or not 60 <= cfg.get("poll_s", 300) <= 3600:
        raise ValueError("service_health.poll_s must be 60..3600")
    for k in ("login_base", "graph_base"):         # override only for testing against a mock
        if k in cfg and not (isinstance(cfg[k], str) and cfg[k].startswith(("http://", "https://"))):
            raise ValueError(f"service_health.{k} must be an http(s) URL")
    return cfg


class ServiceHealth:
    def __init__(self, cfg, timeout=10):
        self.cfg, self.timeout = cfg, timeout
        self.map = dict(DEFAULT_MAP, **cfg.get("map", {}))
        self.lock = threading.Lock()
        self.status, self.fetched, self.error = {}, None, "not polled yet"
        self._token, self._exp, self._since = None, 0, {}

    def _get_token(self):
        if self._token and time.time() < self._exp - 60:
            return self._token
        tenant, cid, sec = (os.environ.get(self.cfg[k], "") for k in ("tenant_env", "client_id_env", "client_secret_env"))
        if not (tenant and cid and sec):
            raise RuntimeError("missing-credentials")
        url = self.cfg.get("login_base", "https://login.microsoftonline.com").rstrip("/") + \
            "/" + urllib.parse.quote(tenant, safe="") + "/oauth2/v2.0/token"
        body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": cid, "client_secret": sec,
                                       "scope": "https://graph.microsoft.com/.default"}).encode()
        with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=self.timeout) as r:
            d = json.loads(r.read(1 << 20))
        self._token, self._exp = d["access_token"], time.time() + float(d.get("expires_in", 300))
        return self._token

    def poll(self):
        """Fetch health overviews once. Never raises; on failure status becomes unknown."""
        try:
            url = self.cfg.get("graph_base", "https://graph.microsoft.com").rstrip("/") + \
                "/v1.0/admin/serviceAnnouncement/healthOverviews"
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self._get_token()})
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                d = json.loads(r.read(4 << 20))
            st = {str(v["service"]): str(v["status"]) for v in d["value"] if isinstance(v, dict) and "service" in v and "status" in v}
            with self.lock:
                self.status, self.fetched, self.error = st, time.time(), None
        except Exception as e:
            with self.lock:
                self.status, self.error = {}, type(e).__name__       # unknown, never "healthy"
        return self.error

    def start(self):
        def loop():
            while True:
                self.poll()
                time.sleep(self.cfg.get("poll_s", 300))
        threading.Thread(target=loop, daemon=True).start()

    def compare(self, state, now_iso="", now=None):
        """Returns {"ms": {probe: microsoft status or "unknown"}, "divergent": {probe: since_iso},
        "error", "age_s"}. A probe is divergent when we see warning/suspect/down and Microsoft's
        status for the mapped service is exactly serviceOperational."""
        now = now or time.time()
        with self.lock:
            status, fetched, error = dict(self.status), self.fetched, self.error
        stale = fetched is None or now - fetched > 3 * self.cfg.get("poll_s", 300)
        ms, div = {}, {}
        for n, st in state.items():
            if n not in self.map:
                continue
            ms[n] = "unknown" if (error or stale) else status.get(self.map[n], "unknown")
            if st in TROUBLE and ms[n].lower() == HEALTHY:
                div[n] = self._since.setdefault(n, now_iso)
            else:
                self._since.pop(n, None)
        return {"ms": ms, "divergent": div, "error": error, "age_s": None if fetched is None else int(now - fetched)}
