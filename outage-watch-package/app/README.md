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
python3 -W ignore -m unittest -v                    # 78 tests
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
| Prometheus metrics / JSON status | `/metrics`, `/status.json`, `/healthz` on the same port |
| Config file (add your own services, tune thresholds) | `--config config.example.json` |
| Incident report with early-warning lead time | `python3 report.py outagewatch.jsonl --md report.md` |
| Freeze levels, hooks, pipeline gate | see PREVENTION.md |

`--serve` listens on localhost only. The read-only pages (`/`, `/status.json`, `/metrics`) have no
authentication, so `--bind` to anything but localhost is refused unless an admin token is set, and
even then put it behind a reverse proxy with auth.

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
