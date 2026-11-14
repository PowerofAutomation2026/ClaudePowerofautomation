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
