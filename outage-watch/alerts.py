"""Alert channels, routing, escalation, ack/snooze and dead-man's switch for outage-watch.

Standard library only. Design rules:
  * Secrets (webhook URLs, tokens, passwords) are read from environment variables whose NAMES
    are given in the config. They are never accepted inline, logged, or put in status.json.
  * One message per incident (not per service per round), a recovery message, a rate limit.
  * A channel hosted on Microsoft 365 / Azure can die in the same outage: warn loudly.
  * Nothing here may ever break probing: every send is wrapped and returns an error string.
"""
import json
import os
import smtplib
import ssl
import tempfile
import threading
import time
import urllib.request
from email.message import EmailMessage
from urllib.parse import urlsplit

TYPES = ("webhook", "slack", "mattermost", "discord", "teams", "telegram", "ntfy", "smtp")
LEVELS = {"ok": 0, "caution": 1, "freeze": 2}
# Hosts that share fate with a Microsoft 365 outage (suffix match).
M365_SUFFIXES = ("office.com", "office365.com", "outlook.com", "microsoft.com", "microsoftonline.com",
                 "azure.com", "azure.net", "windows.net", "azurewebsites.net", "sharepoint.com",
                 "powerautomate.com", "powerplatform.com", "live.com", "office.net")
SECRET_KEYS = ("url", "token", "password", "secret", "webhook", "user")


def m365_hosted(host):
    """Return the matching Microsoft suffix if `host` shares fate with M365, else None."""
    host = (host or "").lower().rstrip(".")
    for suf in M365_SUFFIXES:
        if host == suf or host.endswith("." + suf):
            return suf
    return None


def _env(name):
    v = os.environ.get(name or "", "")
    return v.strip() or None


def validate(cfg):
    """Check the "alerts" config block. Raises ValueError. Returns a normalised copy."""
    if not isinstance(cfg, dict):
        raise ValueError("alerts must be an object")
    chans = cfg.get("channels", {})
    if not isinstance(chans, dict) or len(chans) > 20:
        raise ValueError("alerts.channels must be an object with at most 20 channels")
    for name, c in chans.items():
        w = f"alerts.channels.{name}"
        if not isinstance(c, dict) or c.get("type") not in TYPES:
            raise ValueError(f"{w}.type must be one of {', '.join(TYPES)}")
        for k in c:
            if k in SECRET_KEYS:
                raise ValueError(f"{w}.{k}: secrets are not allowed in the config file; use {k}_env "
                                 "with the NAME of an environment variable")
            if k.endswith("_env") and not (isinstance(c[k], str) and c[k].replace("_", "").isalnum()):
                raise ValueError(f"{w}.{k} must be an environment variable name")
        if c["type"] == "smtp":
            if not isinstance(c.get("host"), str) or not isinstance(c.get("from"), str) or \
                    not (isinstance(c.get("to"), list) and c["to"] and all(isinstance(x, str) for x in c["to"])):
                raise ValueError(f'{w}: smtp needs "host", "from" and a "to" list')
        elif c["type"] == "telegram":
            if not c.get("token_env") or not isinstance(c.get("chat_id"), (str, int)):
                raise ValueError(f'{w}: telegram needs "token_env" and "chat_id"')
        elif not c.get("url_env"):
            raise ValueError(f'{w}: needs "url_env" (name of the env var holding the URL)')
    routes = cfg.get("routes", {})
    if not isinstance(routes, dict) or any(k not in ("caution", "freeze") for k in routes):
        raise ValueError('alerts.routes must be {"caution": [...], "freeze": [...]}')
    for k in list(routes) + ["escalate_to"]:
        lst = routes[k] if k in routes else cfg.get(k, [])
        if not isinstance(lst, list) or any(x not in chans for x in lst):
            raise ValueError(f"alerts: {k} must list configured channel names")
    for k, lo, hi in (("escalate_after_min", 1, 1440), ("repeat_every_min", 0, 1440), ("min_interval_s", 0, 3600)):
        if k in cfg and not (type(cfg[k]) in (int, float) and lo <= cfg[k] <= hi):
            raise ValueError(f"alerts.{k} must be a number in {lo}..{hi}")
    base = cfg.get("base_url")
    if base is not None and not (isinstance(base, str) and base.startswith(("http://", "https://")) and "@" not in base):
        raise ValueError("alerts.base_url must be an http(s) URL without credentials")
    return cfg


def channel_host(c):
    """Best-effort host of a channel, for the independence check. Never returns the secret."""
    if c["type"] == "smtp":
        return c.get("host")
    if c["type"] == "telegram":
        return urlsplit(c.get("api_base", "https://api.telegram.org")).hostname
    url = _env(c.get("url_env"))
    return urlsplit(url).hostname if url else None


def independence_warnings(cfg, legacy_webhook=None):
    """Loud warnings for channels that may fail together with Microsoft 365."""
    out = []
    items = [(n, c["type"], channel_host(c)) for n, c in (cfg or {}).get("channels", {}).items()]
    if legacy_webhook:
        items.append(("--webhook", "webhook", urlsplit(legacy_webhook).hostname))
    for name, typ, host in items:
        suf = m365_hosted(host)
        if suf:
            out.append(f"alert channel '{name}' ({typ}) is hosted on Microsoft infrastructure (*.{suf}): "
                       "it can fail in the same outage it is meant to report. Add a channel that does not "
                       "depend on Microsoft 365 (for example ntfy, Telegram, Slack, or SMTP at another provider).")
    return out


def format_message(kind, level, state, at_risk=(), base_url=None, now="", extra=""):
    """Short, factual text. kind: opened | raised | reminder | escalation | resolved | test."""
    head = {"opened": f"{level.upper()}: new incident", "raised": f"{level.upper()}: incident got worse",
            "reminder": f"{level.upper()}: still open, not acknowledged",
            "escalation": f"{level.upper()}: ESCALATION, nobody acknowledged",
            "resolved": "RESOLVED: all probes healthy again", "test": "TEST: this is a test alert"}[kind]
    lines = [f"[outage-watch] {head} ({now})"]
    bad = sorted(f"{n} {s}" for n, s in state.items() if s not in ("up", "blocked"))
    blocked = sorted(n for n, s in state.items() if s == "blocked")
    if kind != "resolved" and kind != "test":
        lines.append("Probes saw: " + (", ".join(bad) if bad else "no failing probe right now (level is held until it has been stable)"))
        if at_risk:
            lines.append("At risk (depend on a failing service): " + ", ".join(sorted(at_risk)))
    if blocked:
        lines.append("Could not check (blocked by our own proxy/firewall): " + ", ".join(blocked))
    if extra:
        lines.append(extra)
    if base_url:
        lines.append("Dashboard: " + base_url)
    lines.append("Source: our own reachability probes. Cause not confirmed; not a statement from Microsoft."
                 if kind != "test" else "No outage is implied. No action needed.")
    return "\n".join(lines)


def _post(url, body, headers, timeout=10):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


def send(c, text, level="caution", timeout=10):
    """Deliver `text` through channel config `c`. Returns None on success, else a short
    error string that never contains the secret."""
    try:
        typ, js = c["type"], {"Content-Type": "application/json"}
        title = text.split("\n", 1)[0]
        if typ == "smtp":
            msg = EmailMessage()
            msg["Subject"], msg["From"], msg["To"] = title, c["from"], ", ".join(c["to"])
            msg.set_content(text)
            port = int(c.get("port", 587))
            cls = smtplib.SMTP_SSL if c.get("tls") == "implicit" else smtplib.SMTP
            with cls(c["host"], port, timeout=timeout) as s:
                if c.get("starttls", True) and cls is smtplib.SMTP:
                    s.starttls(context=ssl.create_default_context())
                user, pw = _env(c.get("user_env")), _env(c.get("password_env"))
                if user and pw:
                    s.login(user, pw)
                s.send_message(msg)
            return None
        if typ == "telegram":
            token = _env(c["token_env"])
            if not token:
                return "missing env " + c["token_env"]
            url = c.get("api_base", "https://api.telegram.org").rstrip("/") + f"/bot{token}/sendMessage"
            _post(url, json.dumps({"chat_id": c["chat_id"], "text": text}).encode(), js, timeout)
            return None
        url = _env(c["url_env"])
        if not url:
            return "missing env " + c["url_env"]
        if not url.startswith(("http://", "https://")):
            return "env " + c["url_env"] + " is not an http(s) URL"
        if typ == "ntfy":
            h = {"Title": title.encode("ascii", "replace").decode(), "Priority": "5" if level == "freeze" else "3",
                 "Tags": "rotating_light" if level == "freeze" else "warning"}
            tok = _env(c.get("token_env"))
            if tok:
                h["Authorization"] = "Bearer " + tok
            _post(url, text.encode(), h, timeout)
        elif typ == "discord":
            _post(url, json.dumps({"content": text[:1900]}).encode(), js, timeout)
        elif typ == "teams":
            card = {"type": "message", "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard",
                            "version": "1.4", "body": [
                                {"type": "TextBlock", "text": title, "weight": "Bolder", "wrap": True},
                                {"type": "TextBlock", "text": text.split("\n", 1)[-1], "wrap": True}]}}]}
            _post(url, json.dumps(card).encode(), js, timeout)
        else:                                   # webhook, slack, mattermost
            _post(url, json.dumps({"text": text}).encode(), js, timeout)
        return None
    except Exception as e:                      # never raise, never leak the URL
        return type(e).__name__


def heartbeat(url_env, timeout=5):
    """Dead-man's switch: ping an external URL each round, in a daemon thread. If outage-watch
    dies the pings stop and the external service alerts. Failure never affects probing."""
    url = _env(url_env)
    if not url or not url.startswith(("http://", "https://")):
        return None

    def ping():
        try:
            urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "outage-watch/1.0"}),
                                   timeout=timeout).read(64)
            HEARTBEAT["last_ok"], HEARTBEAT["error"] = time.time(), None
        except Exception as e:
            HEARTBEAT["error"] = type(e).__name__
    t = threading.Thread(target=ping, daemon=True)
    t.start()
    return t


HEARTBEAT = {"last_ok": None, "error": None}


class AlertState:
    """Ack / snooze / open incident, persisted as a small JSON file so it survives restarts
    and can be changed from the CLI while the monitor runs (the file is re-read every round)."""

    def __init__(self, path):
        self.path, self.lock = path, threading.Lock()

    def load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get("snooze", {}), dict):
                return {"incident": d.get("incident") if isinstance(d.get("incident"), dict) else None,
                        "snooze": {k: v for k, v in d.get("snooze", {}).items() if type(v) in (int, float)}}
        except (OSError, ValueError):
            pass
        return {"incident": None, "snooze": {}}

    def save(self, d):
        if not self.path:
            return
        folder = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(dir=folder)
        with os.fdopen(fd, "w") as f:
            json.dump(d, f)
        os.replace(tmp, self.path)

    def ack(self, by="cli", now=None):
        """Returns True if there was an open, un-acked incident."""
        with self.lock:
            d = self.load()
            inc = d["incident"]
            if not inc or inc.get("acked"):
                return False
            inc["acked"], inc["acked_at"], inc["acked_by"] = True, now or time.time(), str(by)[:40]
            self.save(d)
            return True

    def snooze(self, service, minutes, now=None):
        """minutes <= 0 removes the snooze."""
        with self.lock:
            d = self.load()
            if minutes > 0:
                d["snooze"][service] = (now or time.time()) + 60 * min(minutes, 7 * 1440)
            else:
                d["snooze"].pop(service, None)
            self.save(d)

    def snoozed(self, now=None):
        now = now or time.time()
        return {k: v for k, v in self.load()["snooze"].items() if v > now}


class AlertManager:
    """Routing + escalation. Call step() once per probe round."""

    def __init__(self, cfg, state, sender=send, legacy_webhook=None):
        self.cfg, self.state, self.sender = cfg or {}, state, sender
        self.channels = dict(self.cfg.get("channels", {}))
        if legacy_webhook:                                   # --webhook keeps working: routed to everything
            self.channels["--webhook"] = {"type": "webhook", "url_env": None, "_url": legacy_webhook}
        self.last_sent, self.log = {}, []                    # channel -> epoch ; recent delivery results

    def _route(self, level):
        r = self.cfg.get("routes", {})
        names = list(r.get(level, r.get("freeze" if level == "caution" else "caution", [])) if r else
                     [n for n in self.channels if n != "--webhook"])
        if "--webhook" in self.channels and "--webhook" not in names:
            names.append("--webhook")
        return names

    def _deliver(self, names, text, level, now, force=False):
        gap = self.cfg.get("min_interval_s", 30)
        sent = []
        for n in names:
            c = self.channels.get(n)
            if not c:
                continue
            if not force and now - self.last_sent.get(n, -1e9) < gap:
                self.log.append({"t": now, "channel": n, "result": "rate-limited"})
                continue
            if c.get("_url"):
                err = _legacy(c["_url"], text)
            else:
                err = self.sender(c, text, level)
            self.last_sent[n] = now
            self.log.append({"t": now, "channel": n, "result": err or "sent"})
            if not err:
                sent.append(n)
        del self.log[:-30]
        return sent

    def step(self, level, state, at_risk=(), muted=(), now=None, now_iso=""):
        """level: automation level; state: {service: published state}; muted: services in a
        maintenance window. Returns the list of (kind, channels) actually sent this round."""
        now = now or time.time()
        with self.state.lock:
            d = self.state.load()
            d["snooze"] = {k: v for k, v in d["snooze"].items() if v > now}
            quiet = set(d["snooze"]) | set(muted)
            vis = {n: s for n, s in state.items() if n not in quiet}
            bad = [n for n, s in vis.items() if s not in ("up", "blocked")]
            hidden_bad = [n for n, s in state.items() if n in quiet and s not in ("up", "blocked")]
            eff = level
            if not bad and hidden_bad:
                eff = "ok"                                   # everything unhealthy is snoozed / in maintenance
            elif bad and level == "freeze" and not any(vis[n] == "down" for n in bad) and vis.get("auth") != "suspect":
                eff = "caution" if hidden_bad else level
            inc, base, out = d["incident"], self.cfg.get("base_url"), []
            risk = [n for n in at_risk if n not in quiet]

            def msg(kind, lvl, extra=""):
                return format_message(kind, lvl, vis, risk, base, now_iso, extra)

            if inc is None and eff != "ok":
                inc = d["incident"] = {"id": int(now), "opened": now, "opened_iso": now_iso, "level": eff,
                                       "acked": False, "escalated": False, "last_notice": now, "notified": []}
                sent = self._deliver(self._route(eff), msg("opened", eff), eff, now)
                inc["notified"] = sent
                out.append(("opened", sent))
            elif inc is not None and eff == "ok":
                took = int((now - inc["opened"]) / 60)
                sent = self._deliver(inc.get("notified") or self._route(inc["level"]),
                                     msg("resolved", "ok", f"Incident lasted about {took} min."), "ok", now, force=True)
                d["incident"] = None
                out.append(("resolved", sent))
            elif inc is not None:
                if LEVELS[eff] > LEVELS.get(inc["level"], 0):
                    inc.update(level=eff, acked=False, escalated=False, last_notice=now, raised=now)
                    sent = self._deliver(self._route(eff), msg("raised", eff), eff, now, force=True)
                    inc["notified"] = sorted(set(inc.get("notified", [])) | set(sent))
                    out.append(("raised", sent))
                elif not inc.get("acked"):
                    since = now - inc.get("raised", inc["opened"])
                    esc, rep = self.cfg.get("escalate_after_min"), self.cfg.get("repeat_every_min", 0)
                    if esc and not inc.get("escalated") and since >= esc * 60 and self.cfg.get("escalate_to"):
                        inc["escalated"], inc["last_notice"] = True, now
                        sent = self._deliver(self.cfg["escalate_to"],
                                             msg("escalation", inc["level"], f"Open for {int(since / 60)} min without acknowledgement."),
                                             inc["level"], now, force=True)
                        inc["notified"] = sorted(set(inc.get("notified", [])) | set(sent))
                        out.append(("escalation", sent))
                    elif rep and now - inc.get("last_notice", inc["opened"]) >= rep * 60:
                        inc["last_notice"] = now
                        out.append(("reminder", self._deliver(self._route(inc["level"]), msg("reminder", inc["level"]), inc["level"], now)))
            self.state.save(d)
            return out

    def test(self, now_iso=""):
        """Send a labelled TEST message through every channel. Returns {channel: result}."""
        text = format_message("test", "caution", {}, base_url=self.cfg.get("base_url"), now=now_iso)
        res = {}
        for n, c in self.channels.items():
            res[n] = (_legacy(c["_url"], text) if c.get("_url") else self.sender(c, text, "caution")) or "sent"
        return res

    def public(self, now=None):
        """What status.json may show: no URLs, no secrets."""
        now = now or time.time()
        d = self.state.load()
        inc = d["incident"]
        return {"channels": [{"name": n, "type": c["type"],
                              "m365": bool(m365_hosted(urlsplit(c["_url"]).hostname if c.get("_url") else channel_host(c)))}
                             for n, c in self.channels.items()],
                "incident": None if not inc else {k: inc.get(k) for k in ("opened_iso", "level", "acked", "acked_by", "escalated", "notified")},
                "snoozed": {k: int(v - now) for k, v in d["snooze"].items() if v > now},
                "recent": [{"channel": x["channel"], "result": x["result"]} for x in self.log[-6:]],
                "heartbeat": "off" if not self.cfg.get("heartbeat_url_env") else
                             ("failing: " + HEARTBEAT["error"] if HEARTBEAT["error"] else "ok" if HEARTBEAT["last_ok"] else "pending")}


def _legacy(url, text):
    try:
        _post(url, json.dumps({"text": text}).encode(), {"Content-Type": "application/json"})
        return None
    except Exception as e:
        return type(e).__name__
