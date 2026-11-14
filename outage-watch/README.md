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
python3 -m unittest -v                             # tests
```
A 401/403/redirect counts as alive (the service answered). 5xx, 429, timeouts and DNS/TLS errors count as down.

## Not yet done
Authenticated mail send/receive round-trip, multi-region probes, Microsoft Service Health API comparison.
