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
python3 -W ignore -m unittest -v                    # 45 tests
```
A 401/403/redirect counts as alive (the service answered). 5xx, 429, timeouts and DNS/TLS errors count as down.

## Features
| Feature | How |
|---|---|
| Live dashboard (dark mode, 5s refresh) | `--serve 8080` then open http://127.0.0.1:8080/ |
| Prometheus metrics / JSON status | `/metrics`, `/status.json`, `/healthz` on the same port |
| Config file (add your own services, tune thresholds) | `--config config.example.json` |
| Incident report with early-warning lead time | `python3 report.py outagewatch.jsonl --md report.md` |
| Freeze levels, hooks, pipeline gate | see PREVENTION.md |

`--serve` listens on localhost only. `--bind 0.0.0.0` exposes it with no authentication,
so put it behind a reverse proxy with auth first.

## Also covers
Copilot services plus automated freeze/caution levels. See PREVENTION.md.

## Not yet done
Authenticated mail send/receive round-trip, multi-region probes, Microsoft Service Health API comparison.

## Verified live (2026-11-14)
Probed all 15 default endpoints from a cloud sandbox: all `up` (HTTP 200/301/302/400/401/404/417 all correctly counted as alive).
Continuous mode, dashboard, `/metrics`, freeze file, pipeline gate and report ran against the live services.
A host refused by a local proxy is reported as `blocked` (your network policy), never as a Microsoft outage or a freeze.
Not live-tested: a real Microsoft outage, so `warning`/`down` detection is covered by tests, not by a live incident.
