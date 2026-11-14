# outage-watch

Independent Microsoft 365 / Outlook health probe. Standard library only (Python 3.9+).

## Why
2026 Outlook / Exchange Online outages showed a pattern. The causes reported so far were
a shared authentication configuration (Aug 31), maintenance deployments (June),
supporting network infrastructure (Mar) and a third-party network provider (Jan).
Root-cause reports often arrive days later. Some of these causes are preliminary
attributions, not final post-incident reports.

Lessons built in:
1. **Probe independently.** Do not wait for the status page.
2. **Probe auth separately from mail**, to tell "sign-in is down" from "mail is down".
3. **Keep your own timeline** (`outagewatch.jsonl`) to compare against the final report.
4. **Alert out-of-band.** Point `--webhook` at a channel not hosted on M365.
5. **Rule out your own network** before blaming Microsoft: if every target fails, the verdict says so.

## Use
```bash
python3 outagewatch.py --once                      # exit 0 healthy, 1 otherwise
python3 outagewatch.py --interval 60 --webhook URL # continuous, alerts on change
python3 outagewatch.py --test                      # manual test: one detailed round, dry run
python3 -W ignore -m unittest -v                    # 113 tests
./deploy/test_deploy.sh                             # 84 checks of the deploy script (real user-mode deploy)
```
A 401/403/redirect counts as alive (the service answered). 5xx, 429, timeouts and DNS/TLS errors count as down.

## Features
| Feature | How |
|---|---|
| Live blast-radius dashboard (light/dark, phone to wall display) | `--serve 8080` then open http://127.0.0.1:8080/ |
| Wall / kiosk mode | http://127.0.0.1:8080/?kiosk=1 |
| Manual test and test alert for admins | `--test`, `--test-alert`, or the dashboard with `OUTAGEWATCH_ADMIN_TOKEN` |
| Fire drills (outage rehearsal, simulation only) | dashboard: Simulation, then Fire drill; edit a copy of `drills.example.json`, pass `--drills` |
| Tamper-evident log | `python3 report.py outagewatch.jsonl --verify` |
| Alert channels, routing, escalation, ack/snooze, dead-man's switch | `"alerts"` in the config, see Alerting |
| Maintenance windows, uptime / SLA with p50/p95 | `"maintenance"` in the config, `--db FILE`, `report.py --sla --csv` |
| Microsoft status divergence (optional, mock-tested only) | `"service_health"` in the config |
| Viewer login, trusted reverse proxy, staff status page | `OUTAGEWATCH_VIEWER_TOKEN`, `--trust-proxy`, `--public-status` |
| TLS certificate and DNS checks | targets `tls://host` and `dns://host` |
| Docker, compose, systemd, CI, one-command deploy | Deployment and Zero-touch deploy |
| Prometheus metrics / JSON status | `/metrics`, `/status.json`, `/healthz` on the same port |
| Config file (add your own services, tune thresholds) | `--config config.example.json` |
| Incident report with early-warning lead time | `python3 report.py outagewatch.jsonl --md report.md` |
| Freeze levels, hooks, pipeline gate | see PREVENTION.md |

`--serve` listens on localhost only and, by default, needs no login there. `--bind` to anything but
localhost is refused unless a viewer token, an admin token or a trusted proxy is configured (see Access control).

## Dashboard
A single self-contained page (`dashboard.html`; no CDN, no external requests, strict Content-Security-Policy
with hashed inline script/style). It polls `/status.json` every 5 s.
- **Blast-radius map.** Sign-in in the centre, services that need it around it, Copilot on the outer arc on
  top of the data services it reads (edges come from `DEPENDS_ON_AUTH` / `COPILOT_NEEDS`). When a node
  degrades, the failure is drawn travelling along the edges to its dependents ("at risk"). State is encoded
  by shape + icon + text, not colour alone. Select a node to see what fails with it. Services added with
  `--config` appear under "no modelled dependency".
- **Can I do my job?** Tasks mapped to the services they need (`"roles": {"Payroll": ["auth", "my-app"]}` in
  the config replaces the defaults). "Copy staff update" drafts a short factual message from the current
  state. It says what the probes saw and never states a cause.
- **Early-warning timeline.** Latency sparkline per service against its learned baseline, with the warning
  region hatched, plus the stress score (below).
- **Replay.** Scrub back through the rounds the page has seen (the server keeps the last 120 for new tabs).
- **Simulation / demo and fire drills.** Runs only in the browser tab, always labelled SIMULATION. It never
  sends anything to the server, so it cannot write the freeze file, fire hooks or webhooks, or appear in the
  log. A fire drill adds a stopwatch, a response checklist and a drill summary with the time to each step.
- **Stale warning.** If `/status.json` stops answering or stops changing, a STALE banner appears: a dead
  monitor must not look like a healthy service.
- **Kiosk** (`?kiosk=1`): large type, clock, controls hide after 6 s without input. "Sound alert" is off by
  default and must be switched on by a click (browser rule); it beeps on a level escalation or on STALE.
- **Export snapshot.** Downloads one static HTML file of the current view (no scripts, no external requests,
  no target URLs) for a ticket or a briefing.

## Manual test (admins)
```bash
python3 outagewatch.py --test                       # all services, detailed table
python3 outagewatch.py --test --only auth exchange --json
python3 outagewatch.py --test --apply --freeze-file F --on-change CMD --webhook URL   # act on the result
python3 outagewatch.py --test-alert --webhook URL --on-change CMD                      # prove alerting works
```
`--test` is a dry run: it does not write the freeze file, the log, hooks or the webhook unless `--apply` is
given. Exit code 0 = healthy, 1 = problem, 2 = bad usage. `blocked` is not counted as a problem.
`--test-alert` sends a message labelled TEST and runs the hook once with `OUTAGEWATCH_LEVEL=test`; it prints
what was sent and the hook's exit code.

The dashboard has the same thing as buttons ("Run test now", "Retest" on a selected node, "Send test
alert"). They call `POST /api/test` and `POST /api/test-alert`, which are **disabled unless a token is set**:
```bash
OUTAGEWATCH_ADMIN_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')" \
  python3 outagewatch.py --serve 8080
```
The API needs `Authorization: Bearer TOKEN` (constant-time compare, 16+ characters), POST with
`Content-Type: application/json`, same-origin, body under 4 KB, at most one run per 5 s per endpoint, and a
one-minute lockout after 20 bad tokens. The client can only name services from the configured target list,
never URLs. From the dashboard a manual test is always a dry run. The page keeps the token in the input
field only (not in storage, not in the URL). `--admin-token` also works but shows up in the process list.
The token travels in clear text over plain HTTP, so use it on localhost or behind TLS.

## Stress score
A transparent heuristic per service, 0-100, over the last 10 probe rounds. It is not a prediction, not
machine learning, and gives no time-to-failure.
```
score = round(100 * min(1, 0.5*D + 0.2*J + F))
D drift    = (median of last 3 answered probes - baseline) / (warning threshold - baseline), clamped 0..1
J jitter   = mean |change between consecutive answered probes| / baseline, clamped 0..1
F failures = failed probes (suspect/down) in the last 5 rounds * 0.5, capped at 1
```
Blocked probes are ignored; without a learned baseline D and J are 0. Bands: 0-29 calm, 30-59 elevated,
60-100 high. Exposed as `stress` in `/status.json` and `outagewatch_stress_score` in `/metrics`.

## Tamper-evident timeline
Every log record carries `prev` (hash of the record before it) and `hash` (sha256 of its own content
including `prev`). `python3 report.py LOG --verify` reports the first line where a record was edited,
deleted, inserted or reordered, and exits 1. The incident report prints a "chain verified" line.
Limits, stated plainly: this detects piecemeal changes. Someone who can rewrite the whole file can also
recompute the whole chain, and cutting records off the end leaves a valid shorter chain. It becomes real
evidence only if you anchor the head hash outside this host: after an incident, run `--verify`, paste the
printed head hash somewhere the host cannot change (a ticket, an email to yourself, a chat channel), and
later check with `--verify --expect-head HASH`. It is not a legal timestamp on its own.
Old logs without hashes still load; the chain starts at the first new record.

## Also covers
Copilot services plus automated freeze/caution levels. See PREVENTION.md.

## Not yet done
Authenticated mail send/receive round-trip, multi-region probes, Microsoft Service Health API comparison.

## Verified live (2026-11-14)
Probed all 15 default endpoints from a cloud sandbox: all `up` (HTTP 200/301/302/400/401/404/417 all correctly counted as alive).
Continuous mode, dashboard, `/metrics`, freeze file, pipeline gate and report ran against the live services.
A host refused by a local proxy is reported as `blocked` (your network policy), never as a Microsoft outage or a freeze.
Not live-tested: a real Microsoft outage, so `warning`/`down` detection is covered by tests, not by a live incident.
The dashboard was checked in headless Chromium against the live probes (and in simulation for failure states).

## Alerting
The point: an alert path that lives on Microsoft 365 dies in the outage it should report.
```json
"alerts": {
  "base_url": "https://status.example.org/",
  "channels": {
    "push":  {"type": "ntfy",     "url_env": "OW_NTFY_URL"},
    "slack": {"type": "slack",    "url_env": "OW_SLACK_URL"},
    "tg":    {"type": "telegram", "token_env": "OW_TG_TOKEN", "chat_id": "123456"},
    "mail":  {"type": "smtp", "host": "smtp.example.org", "port": 587, "from": "ow@example.org",
              "to": ["oncall@example.org"], "user_env": "OW_SMTP_USER", "password_env": "OW_SMTP_PASS"}
  },
  "routes": {"caution": ["slack"], "freeze": ["slack", "push"]},
  "escalate_after_min": 15, "escalate_to": ["mail"], "repeat_every_min": 0, "min_interval_s": 30,
  "heartbeat_url_env": "OW_HEARTBEAT_URL"
}
```
- Types: `webhook`, `slack`, `mattermost`, `discord`, `teams` (adaptive card for a Teams workflow webhook),
  `telegram`, `ntfy`, `smtp`. **Secrets never go in the config**: give the NAME of an environment variable
  (`url_env`, `token_env`, `user_env`, `password_env`). A config with an inline `url`, `token` or `password` is rejected.
- **Independence check.** At startup (stderr) and in the dashboard, any channel hosted on Microsoft
  infrastructure (`*.office.com`, `*.office365.com`, `*.outlook.com`, `*.azure.com`, `*.microsoft.com`, ...) gets a
  loud warning. It is a warning, not a block.
- **One message per incident**, not per service per round: opened, got worse (caution to freeze), reminder
  (optional), escalation (once, if nobody acknowledged within `escalate_after_min`), resolved. `min_interval_s`
  rate-limits each channel. Messages say what the probes saw, the level, at-risk services and the dashboard link;
  they never state a cause.
- **Ack / snooze.** `python3 outagewatch.py --ack`, `--snooze NAME MINUTES` (0 removes it), or the dashboard's
  Alerting panel (admin token, same protections as the manual test). Ack stops escalation; snooze mutes one
  service's alerts while it stays probed and visible. State is a small JSON file (`--alert-state`, default
  `outagewatch-alerts.json`) so it survives restarts.
- **Dead-man's switch.** `heartbeat_url_env` names a variable holding a ping URL (healthchecks.io style). It is
  pinged every round in a background thread; if outage-watch dies the pings stop and that service alerts you.
  A failing ping never affects probing.
- `--test-alert` sends a labelled TEST message through every configured channel.
- Verified: payloads against local mock HTTP and SMTP servers, and one live run against a local receiver.
  **Not verified against the real Slack, Teams, Discord, Telegram, ntfy, Mattermost or a real mail provider.**

## Maintenance windows and uptime / SLA
```json
"maintenance": [
  {"services": ["exchange"], "start": "2026-12-01T22:00", "end": "2026-12-02T02:00", "tz": "Europe/Berlin", "note": "patching"},
  {"services": ["*"], "weekly": {"day": "sun", "start": "02:00", "duration_min": 120}, "tz": "UTC"}
]
```
In a window the named services are still probed and logged (record field `maintenance`), shown as
"maintenance" in the dashboard and reports, but do not raise the freeze level or alert.

`--db outagewatch.db` (or `"db"` in the config) mirrors every round into SQLite; `"retention_days"` (default 90)
trims it. The dashboard then shows uptime for 24 h / 7 d / 30 d with p50/p95 latency. Reports:
`python3 report.py LOG --sla [--db FILE] [--csv out.csv] [--include-maintenance]`. Without `--db` the log is
streamed line by line into a temporary SQLite file, not loaded into memory. Uptime here means the share of
probe rounds answered (up or warning); blocked probes and maintenance samples are not counted. It is an
unauthenticated reachability figure with the resolution of your probe interval, not a contractual SLA number.
The JSONL stays the evidence log; the database is a rebuildable copy.

## Microsoft status divergence (optional, NOT verified against the real API)
```json
"service_health": {"tenant_env": "OW_TENANT_ID", "client_id_env": "OW_CLIENT_ID", "client_secret_env": "OW_CLIENT_SECRET",
                   "poll_s": 300, "map": {"exchange": "Exchange Online"}}
```
With an app registration that has the application permission `ServiceHealth.Read.All` (admin consent), outage-watch
reads `admin/serviceAnnouncement/healthOverviews` from Microsoft Graph. When a probe is warning/suspect/down
while Microsoft reports that service as `serviceOperational`, the dashboard shows
"DIVERGENCE: our probes see trouble, Microsoft status does not (yet)" with the time it started, and the
incident report gets a "Microsoft status confirmed after" column.
**This was tested only against a local mock of Graph. No credentials were available, so the token flow, the
endpoint and the default service-name mapping are unverified against the real service; check the mapping
against your tenant and override it with `map`.** The adapter itself needs sign-in and Graph: if it cannot
read the status it reports "unknown", which is never counted as "Microsoft says healthy".

## Access control
- Default: localhost only, no login.
- `OUTAGEWATCH_VIEWER_TOKEN` (16+ characters, different from the admin token) protects `/`, `/status.json`
  and `/metrics`. The browser gets a login page; the token is exchanged for an HttpOnly, SameSite=Strict session
  cookie (12 h). It is never accepted in a URL and never stored by the page. 20 bad attempts lock logins for a
  minute. Prometheus can send `Authorization: Bearer <viewer token>`. The viewer token cannot call the admin API.
- `--trust-proxy 10.0.0.5 [--proxy-user-header X-Forwarded-User]`: requests from exactly that address that
  carry the identity header are treated as signed in. The header is ignored from any other address.
- Sessions live in memory (a restart signs everyone out). There are no user accounts or roles beyond
  viewer/admin. Use TLS (a reverse proxy) whenever this leaves localhost.

## Staff status page
`--public-status` serves `/status` (and `/status-public.json`) without login: one line per task from the role
view ("Should work", "May be slow or unreliable", "Unlikely to work right now"), the last check time, nothing
else. No URLs, latency, verdict text or internal service names, unless you give a service a public label:
`"public_labels": {"exchange": "Mail servers"}`.

## More check types
- `"cert": ["tls://portal.example.org:443?warn_days=21", null]` checks the certificate with normal verification:
  `down` if the handshake fails (including an expired certificate), `warning` when fewer than `warn_days` remain.
- `"autodiscover": ["dns://autodiscover.example.org?expect=autodiscover.outlook.com", null]` resolves with the
  system resolver: `down` if it does not resolve, `warning` if it resolves to something unexpected. `expect`
  takes IPs or a canonical-name suffix.
- Worth watching for Microsoft 365 (use your own domain): `autodiscover.<your domain>` (should point at
  `autodiscover.outlook.com`) and the host your MX record points to (`<something>.mail.protection.outlook.com`)
  as a `dns://` target. The stdlib resolver can only look up addresses and canonical names, so the MX record
  itself, SPF and DKIM (TXT/CNAME selectors) cannot be queried here.
- Not verified live: outbound TLS/DNS probes to the internet (the build sandbox only allows HTTPS through a
  proxy). They are tested against localhost and a local TLS server.

## Deployment
- `Dockerfile` (non-root uid 10001, healthcheck on `/healthz`), `docker-compose.yml` (published on host
  `127.0.0.1` only, read-only root, all capabilities dropped, tokens from `outagewatch.env`).
- `deploy/outage-watch.service`: systemd unit example (dedicated user, `EnvironmentFile`, `Restart=on-failure`).
- Windows: see the separate Windows package in this repository for the scheduled-task install.
  By hand: Task Scheduler, trigger "At startup", action `python.exe outagewatch.py --serve 8080 ...`,
  "Restart on failure" in Settings; or wrap the same command with NSSM. Set the tokens as machine environment variables.
- `.github/workflows/outage-watch-tests.yml` runs the unit tests (Python 3.9 and 3.13) and shellcheck on push.
- Not run here: `docker build` (no Docker daemon in the build sandbox), the systemd unit (no systemd), the
  GitHub workflow, and shellcheck (not installed).

## Zero-touch deploy (Linux / macOS)
```bash
./deploy/deploy.sh --env-id <environment-guid> --yes        # deploy or upgrade
./deploy/deploy.sh --env-id <environment-guid> --dry-run    # print every action, change nothing
./deploy/deploy.sh --env-id <environment-guid> --uninstall  # stop and remove; add --purge to delete data
```
The ID can also come from `OUTAGEWATCH_ENV_ID`, or you are asked for it.

**What the environment ID is used for.** outage-watch cannot run inside Power Platform and reads nothing
from the environment. The ID only (1) names the deployment `outagewatch-<first 8 characters>`, (2) selects the
state directory `.deploy-state/<id>/` (config, tokens, data, hash-chained log), (3) becomes the label in the
dashboard and the `outagewatch_info{deployment=...}` metric, and (4) adds one probe for that environment's maker
portal, `https://make.powerapps.com/environments/<id>/home` (alive on any answer below 500).

**What it does**, as a numbered plan with ok / warn / FAIL: preflight (Python 3.9+, offers `apt`/`brew` install
only with `--yes` or your consent; detects Docker and systemd), writes a config with safe defaults, generates an
admin and a viewer token with Python's `secrets` module into `outagewatch.env` (mode 600; never printed, logged
or passed as arguments), runs the unit tests as a gate, runs a live `--test` and reports up / blocked / down,
installs and starts (Docker compose if a daemon is reachable, else systemd on Linux, else user mode), waits for
`/healthz`, smoke-tests `/status.json` and `/metrics` with and without the viewer token and that an
unauthenticated `POST /api/test` is rejected, then prints where everything is. A re-run is an upgrade that keeps
tokens, config, data and log. On failure it removes what that run created and says what is left.

**What it will not do.** Open a firewall port, bind beyond localhost unless you pass `--bind`, install a launchd
job on macOS (user mode only; add your own LaunchAgent that sources the env file), configure alert channels, or
run as root (it refuses unless `--mode systemd`, where root installs the unit and the service runs as the
unprivileged `outagewatch` user; `--allow-root` exists for containers).

**Honest limits.** The GUID is validated strictly (8-4-4-4-12 ASCII hex) before it is used anywhere.
Verified in the build sandbox with `deploy/test_deploy.sh`: hostile-input rejection, dry run, a real user-mode
deploy (`--no-service`), token file mode, the test gate, smoke tests, rollback on a busy port, upgrade, uninstall
and purge. With a token configured the app answers an unauthenticated `POST /api/test` with 401 (403 is what it
answers when the admin API is disabled); the script accepts either. **Not exercised: the Docker path, the
systemd path, the package-manager install of Python, and macOS** (no Docker daemon, no systemd, Linux only).
shellcheck was not available, so the script is only `bash -n` checked.
