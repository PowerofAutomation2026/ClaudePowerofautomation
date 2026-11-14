# Prevention playbook for Microsoft 365 outages

You cannot stop a failure inside Microsoft's service. You can (1) see it earlier, and
(2) shrink what it does to you. outage-watch covers (1). This list covers (2).
Reported 2026 causes: shared auth config, maintenance deployments, network infrastructure.
These are preliminary attributions, not final reports.

## Early detection (automated)
- Run `outagewatch.py --tenant <name> --webhook <non-M365 URL>` somewhere that is NOT on M365.
- States: `warning` (latency far above baseline), `suspect` (1 failed probe), `down` (2 in a row).
- If `auth` is suspect/down the verdict lists every dependent service at risk.

## Prevention: reduce blast radius (manual, do once)
| Risk shown by 2026 outages | Action |
|---|---|
| Sign-in is a single dependency | Keep 2 cloud-only break-glass admin accounts, excluded from Conditional Access, with offline credentials and alerts on use. |
| Nobody can reach comms | Pre-agree an out-of-band channel (SMS group, non-M365 chat). Keep the contact list outside M365. |
| Outlook needs the service | Use Outlook cached mode so staff can read and draft offline. |
| Mail is business-critical | Evaluate a mail continuity/queueing service in front of Exchange Online, and check what it does with your MX. |
| Updates and config changes cause incidents | Test Conditional Access in report-only mode first. Avoid your own tenant changes during a Microsoft incident. |
| Status pages lag | Subscribe to Service Health notifications and keep your own timeline (`outagewatch.jsonl`). |
| Need SLA evidence | Keep the log. Compare with Microsoft's PIR when published. |
| Others depend on you | Document which processes (flows, approvals, on-call) depend on which service. |

## During an incident
1. Check the verdict: is it your network, auth, or one service?
2. Switch to the out-of-band channel.
3. Don't change tenant config while the provider is degraded.
4. Save the timeline.

## Automated early prevention (built in)
Run continuously with a flag file and an optional hook:
```bash
python3 outagewatch.py --tenant contoso --freeze-file /var/run/m365-freeze.json \
  --on-change './pause-deployments.sh' --webhook "$NON_M365_WEBHOOK"
```
| Level | Trigger | Meaning |
|---|---|---|
| `ok` | all up | normal |
| `caution` | any `warning` / `suspect` | advisory: watch, avoid risky changes |
| `freeze` | any `down`, or sign-in `suspect` | block tenant/CA/licensing changes and deployments |

Escalation is immediate. Recovery needs 3 clean rounds in a row, so a flapping service doesn't unfreeze early.
The hook gets `OUTAGEWATCH_LEVEL` and `OUTAGEWATCH_SERVICES` env vars.

Pipeline gate (exit 1 blocks; a missing file means safe, a corrupt file blocks):
```yaml
- script: python3 outagewatch.py --check-freeze /var/run/m365-freeze.json
  displayName: Block deploy during M365 incident
```
Copilot services (M365 Copilot, Copilot Studio, Copilot web, GitHub Copilot) are probed too.
If Copilot is unhealthy, the verdict names the mail/files/chat services under it that are also unhealthy.

## Rehearse it: fire drills
Open the dashboard, switch on **Simulation / demo**, pick a **Fire drill** and start it. Four scenarios follow
the pattern types reported in 2026 (shared sign-in failure, maintenance slowdown of one service, partial
network outage, Copilot-only failure). The map and freeze level react as they would, a stopwatch runs, and
each checklist step records when it was ticked. "End drill" gives a summary you can paste into a ticket.
Copy `drills.example.json`, replace the checklist text with your own names and channels, and start with
`--drills yourfile.json`. A drill is simulation only: it cannot touch the freeze file, hooks, webhook or log.

## Prove the alert path works
`python3 outagewatch.py --test-alert --webhook "$NON_M365_WEBHOOK" --on-change './pause-deployments.sh'`
sends a message labelled TEST and runs the hook with `OUTAGEWATCH_LEVEL=test`. Make your hook treat `test`
as a no-op. `--test` runs one manual probe round without changing anything (add `--apply` to act on it).

## Keep the evidence honest
The log is hash-chained. After an incident run `python3 report.py outagewatch.jsonl --verify` and store the
printed head hash outside the host. See README, "Tamper-evident timeline", for what this does and does not prove.

## Make sure the alert survives the outage
Put at least one alert channel outside Microsoft 365 (ntfy, Telegram, Slack, SMS gateway, SMTP at another
provider). outage-watch warns at startup when a channel is hosted on Microsoft infrastructure. Add a
dead-man's-switch URL (`heartbeat_url_env`) so that a dead monitor is noticed too. Decide who acknowledges:
an unacknowledged incident escalates to `escalate_to` after `escalate_after_min`. See README, "Alerting".

## Planned work is not an incident
Declare tenant maintenance in `"maintenance"` so it neither freezes pipelines nor pages people, while staying
in the timeline and excluded from uptime figures.

## Coverage: 36 services, and your tenant name
Start with `--tenant <name>` (the name in `<name>.sharepoint.com`) so SharePoint Online and OneDrive are probed;
without it they show as "unconfigured", which is neutral and never alerts. The list now also covers Power BI,
Power Apps/Automate, Forms, Planner, Loop, Viva Engage, the Defender, Purview, Entra, Azure and Teams admin
portals, and the Teams/Office CDNs. See README, "The 36 monitored services". The role view maps them to tasks
("Dashboards & reporting", "Forms & tasks", "Security & compliance admin", "Teams admin").
