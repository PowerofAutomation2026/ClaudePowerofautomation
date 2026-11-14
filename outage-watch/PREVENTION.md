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
