# Outage Watch - Power Platform edition

A Power Platform-native version of **outage-watch**: it probes Microsoft 365 + Copilot endpoints, keeps the raw
facts in Dataverse and shows a blast-radius dashboard. One command deploys all of it from the environment ID.

```
Deploy-OutageWatchPP.cmd 00000000-0000-0000-0000-000000000000
```

(or double-click `Deploy-OutageWatchPP.cmd` and paste the ID when asked).

> **Same-fate warning - read this first.** The probes run in a Power Automate cloud flow *inside Microsoft's
> cloud*, and the dashboard is served by Power Apps. If Power Platform, Dataverse or Entra sign-in fails, this
> monitor fails with it. It **cannot** be the independent outside vantage point that the Python monitor is.
> Use it as the convenient in-tenant view, and keep the host-based Python monitor (`outage-watch-package`) on a
> machine outside Microsoft 365 as the witness. Mitigations built in: a **STALE** banner, an optional external
> **heartbeat** (dead man's switch), and this warning in the dashboard footer and the deploy summary.

**Status: not yet run against a real tenant.** Everything that could be verified without one was (see
"What was verified"). The PowerShell script itself has not been executed: no PowerShell was available where it
was written. Expect to fix small things on the first real run; `DESIGN.md` lists every unconfirmed item.

## What gets deployed

| Piece | What it is |
|---|---|
| Dataverse solution `OutageWatch` (publisher prefix `owatch_`) | tables `owatch_target` (name, URL, alive codes, depends-on-sign-in, Copilot-needs-it, enabled, family), `owatch_result` (target, HTTP status, elapsed ms, error kind, time, round) and `owatch_setting` (name/value, no secrets) |
| 36 seeded targets in 9 families | the same services, URLs, alive-code rules, dependencies and families as `outagewatch.py` (checked by a test against the real Python). 34 are probed out of the box. `sharepoint-online` and `onedrive-business` are tenant-specific: with `-TenantName contoso` they are probed; without it they are seeded **disabled, with no URL**, never probed, and shown as the neutral **unconfigured** state - never a failure |
| Cloud flow `Outage Watch - probe` | every 10 min: unauthenticated `GET` on every enabled target, **all in parallel** (no retries, 10 s timeout, async polling off), **one raw row per probe**, prune rows older than the retention, optional heartbeat ping. The flow never decides whether something is "up" |
| Connection reference `owatch_dataverse` | binds the flow to your Microsoft Dataverse connection |
| Code app `Outage Watch` (React + TypeScript) | reads the tables, computes states **in the browser** with a tested port of the Python logic, shows the blast-radius map (family clusters on a sign-in bus and a Copilot bus, filter box, "show only problems", collapsible families), "Can I do my job?" (11 tasks), STALE banner, and a clearly labelled SIMULATION mode |

## Requirements

- Windows with Windows PowerShell 5.1 or PowerShell 7. Node.js 20+ and the Power Platform CLI (`pac`) are installed
  by the script if missing (winget / dotnet tool), exactly like the existing Ownership Command Center script.
- An environment **with a Dataverse database**, and you as **System Administrator** (or System Customizer) in it.
- **"Enable code apps"** turned on for the environment (admin center > Manage > Environments > the environment >
  Settings > Product > Features). There is no documented API to read or set this switch.
- Licences: **Power Automate Premium** for the flow owner (the HTTP action is a premium connector; alternatively a
  Process licence on the flow) and **Power Apps Premium** for everyone who opens the dashboard.
- No data-loss-prevention policy that separates the HTTP connector from Microsoft Dataverse.

## What "zero touch" honestly means

You type the environment ID. Everything else has defaults. These interactions cannot be removed by any script:

| Interaction | When | How the script handles it |
|---|---|---|
| Sign in to the Power Platform CLI (browser) | only if no `pac` profile exists | opens the sign-in; continues by itself |
| Sign in once more for the Dataverse Web API token (browser) | only if there is no `Az.Accounts` session for the tenant (and no `az login`) | `pac` does not expose a Dataverse token through a documented command, so the documented `Get-AzAccessToken` route is used; the module is installed for the current user if missing |
| Create the Microsoft Dataverse connection (one click + consent) | only if you have none in this environment | opens the exact page and **polls** until the connection exists; no re-run |
| One `Y` to confirm the target | every run | skipped with `-Yes` |
| First launch of the dashboard: approve the connection prompt | once per user | Power Apps shows it |

Happy path on a machine that already has a `pac` profile, an Az session and a Dataverse connection, with `-Yes`:
**zero** interactions after the command. Worst case on a brand-new machine: **3** (two sign-ins, one "Create").
If anything stops the run, re-run the same command: every step reads first and creates only what is missing.

## Options

```
Deploy-OutageWatchPP.cmd <environment-id> [-Yes] [-DryRun] [-SkipTests] [-IntervalMinutes 10] [-RetentionDays 7]
                         [-TenantName contoso] [-SetHeartbeat | -ClearHeartbeat] [-SkipDashboard]
                         [-EnvironmentUrl https://org.crm4.dynamics.com] [-SmokeWaitSeconds 240]
Uninstall-OutageWatchPP.cmd <environment-id> [-Purge] [-Yes]
```

- `-DryRun` prints every Dataverse request of a first deployment and the usage estimate. No sign-in, no changes.
- `-SetHeartbeat` asks (hidden input) for a ping URL from an **external** service such as healthchecks.io; the flow
  calls it after every completely written round. If the pings stop, that service alerts you from outside
  Microsoft. For unattended runs set the environment variable `OUTAGEWATCH_HEARTBEAT_URL` instead. The URL is
  never printed, logged or stored in a table; it lives in the flow definition (readable by flow owners and
  system administrators) with secure inputs/outputs so it stays out of the run history. A later deploy without
  the flag keeps it; `-ClearHeartbeat` removes it.
- `-Uninstall` turns the flow off and deletes it; data stays. `-Purge` also deletes the tables with all results,
  the connection reference, the solution and the publisher. The dashboard app must be deleted by hand in
  make.powerapps.com (no documented CLI command), and your Dataverse connection is never touched.
- Advanced / CI: `OUTAGEWATCH_DATAVERSE_TOKEN` supplies a ready-made bearer token for the organisation.

## Cost: flow runs count against your request quota (read before lowering the interval)

Microsoft counts every trigger and action that runs as one Power Platform request. A Power Automate Premium (or
Power Apps Premium) user has **40,000 per 24 hours**. Per run the flow needs 1 trigger + 5 fixed actions + 2 per
enabled target (probe, record) + about 1 delete per target once pruning is in steady state:

| Enabled targets | Interval | Requests/run | Runs/day | Requests/day | Share of 40,000 |
|---|---|---|---|---|---|
| 34 (default, no tenant name) | **10 min (default)** | 108 | 144 | **15,552** | **39%** |
| 36 (with `-TenantName`) | 10 min | 114 | 144 | 16,416 | 41% |
| 34 | 5 min | 108 | 288 | 31,104 | **78% - too little headroom** |
| 36 | 5 min | 114 | 288 | 32,832 | 82% |
| 34 | 3 min | 108 | 480 | 51,840 | 130% - throttled |
| 15 (the earlier version) | 5 min | 51 | 288 | 14,688 | 37% |

**The default interval was raised from 5 to 10 minutes when the catalogue grew from 15 to 36 services**, because
5 minutes would consume about 78% of one Premium licence - more than the 60% that leaves reasonable room for the
owner's other flows. The honest trade-off of 10 minutes:

- a failure is `suspect` after up to 10 minutes and confirmed `down` after up to 20 (two rounds);
- the STALE banner (3 x interval) needs 30 minutes of silence instead of 15;
- the independent Python monitor probes every 60 seconds; this edition is the in-tenant overview, not the fast alarm.

If you want 5 minutes, pass `-IntervalMinutes 5`: the deploy prints a loud WARNING with the percentage before it asks
for confirmation; consider a Process licence on the flow (250,000/day) or disabling targets you do not need
(`owatch_enabled = No`; disabled rows cost nothing). A heartbeat adds one request per run. Microsoft's limits are
per user across all their flows once the current transition period ends. A Microsoft 365 "seeded" licence
(6,000/day) is not enough and cannot run the premium HTTP action anyway. Rows: 4,896 per day, about 34,000 at the
default 7-day retention.

**Does one round fit in the interval?** Yes, because the probes do not run one after another. The "for each" loop
uses the documented maximum concurrency of 50, so all 36 probes start together and a round takes roughly one probe
timeout at worst (10 s) plus the Dataverse writes - budgeted at 70 s, against a 600 s interval. Sequentially, 36
timeouts would take 6 minutes. The trigger additionally has concurrency 1, so a slow run can only delay the next
one, never overlap it. More than 50 enabled targets would need a second wave (+10 s worst case).

## How states are computed

The flow stores facts; `src/logic/classify.ts` judges them, replaying the rounds oldest first:

- raw: no HTTP answer, 5xx or 429 = failed; a status outside the target's alive list, or slower than 3 s = degraded;
  no alive list = any answer below 500 except 429 is proof of life (a 3xx counts: redirects never need following);
- **suspect** after one failed probe, **down** after 2 in a row (`confirm`); a single blip never confirms;
- **warning** when latency exceeds `max(3 x baseline, baseline + 800 ms)`, the baseline being the median of the
  last 20 healthy samples (needs 5); slow samples never poison the baseline;
- level **freeze** when anything is down or sign-in is even suspect, **caution** for warning/suspect, **ok**
  otherwise; escalation is immediate, recovery needs 3 clean rounds;
- **unconfigured** (a tenant-specific target without a tenant name) and **blocked** are neutral: they never raise
  the level, are never "at risk", and never count as an incident;
- the verdict ignores unconfigured targets (it only counts them at the end), reports a blocked probe **without
  hiding a real failure**, and caps long name lists ("... and 16 more");
- auth failing puts every sign-in-dependent service at risk; Copilot problems name the unhealthy service underneath.

Differences from the Python monitor, on purpose: the dashboard only knows the rows it loaded (last 12 hours), so
state "before the window" is unknown; there is no freeze file, hook or webhook (a browser page cannot run them);
`blocked` almost never occurs (see DESIGN.md); the "at risk" list in the verdict is capped at 8 names for display. Thresholds (`confirm`, `factor`, `floor_ms`, `slow_ms`,
`recover_after`) and the role list (`roles_json`) are rows in `owatch_setting`; targets are rows in
`owatch_target`. Edit them in the maker portal; a re-deploy never overwrites your edits.

## Upgrading from the 15-target version

Run the same command again. The upgrade is additive and tested against a mock of a v1 deployment:

- the `owatch_family` column is added; 19 new targets are created; existing rows and your edits are untouched;
- old tenant rows are **renamed in place** (`sharepoint` -> `sharepoint-online`, `onedrive` -> `onedrive-business`):
  same row, same URL, still enabled, no duplicate. If you never used `-TenantName`, the two are added as disabled
  "needs tenant name" placeholders; a later run with `-TenantName contoso` fills them in;
- **result history is kept and not rewritten**: old result rows keep the old name and the dashboard reads them under
  the new one, until they age out with the retention;
- the role list is replaced by the new 11 rows only if it still equals the old shipped default;
- the interval follows the new default (5 -> 10 min) unless you pass `-IntervalMinutes`.

## What was verified, and what was not

Verified here (`npm test`, 153 tests; `npm run build`; headless Chromium):

- the TypeScript logic against **golden cases produced by the real Python code** (`tests/golden/gen_golden.py`
  runs the updated 36-service `outage-watch/outagewatch.py`): the catalogue itself (36 services, URLs, alive codes,
  dependencies, families, roles, tenant-name rules), `probe()` state rules on 61 status/alive-code cases, the Monitor
  scenarios from the Python tests incl. `unconfigured`, 13 verdict cases (blocked never hides a failure, capped lists,
  unconfigured ignored) compared as whole strings, 7 role-view cases, and 450 seeded random rounds over 20 services
  through Monitor + Automation + impact + Copilot note + diagnose + role view + stress score, step by step;
- the provisioning **request sequence against a mock Dataverse over real local HTTP**: first deploy, a second run
  with zero writes, resume after a partial run, schema upgrade, **upgrade from a 15-target deployment** (rename in
  place, no duplicates, history untouched), tenant name added later, heartbeat add/keep/remove, flow that cannot be
  turned on, wrong token, 429 retry, uninstall and purge, and the CLI exit codes the PowerShell script relies on;
- payload structure (flow `clientdata` envelope, table/column metadata) against the documented shapes;
- input validation with hostile input, including the literal GUID pattern extracted from the `.ps1`;
- static checks of the `.ps1`: balanced blocks, no PowerShell 7-only syntax, ASCII only, no secret in any output line;
- the dashboard in demo mode with 36 services at 1440 px dark/light and 360 px: no console errors, no horizontal
  overflow, no overlapping nodes (measured on the rendered page), filter / only-problems / collapse exercised.

**Not verified:** anything against a real tenant; `pac` (any command); the real flow import and activation; the
real Dataverse metadata API; the real code-app publish; execution of the PowerShell script (static checks only).
The mock Dataverse is a model written from the documentation, not Microsoft's implementation.

## Manual steps that remain

1. Have code apps enabled and the licences assigned (admin, once).
2. Run the command; sign in / click "Create" if prompted.
3. Open the dashboard URL from the summary and approve the connection prompt.
4. For other viewers: share the app, and give them a security role with **Read** on the three `owatch_` tables
   (the script does not create a role).
5. Recommended: `-SetHeartbeat`, and keep the independent Python monitor running elsewhere.

## Troubleshooting

- *Flow created but OFF*: the script prints Power Automate's message and opens the flow. Usual causes: no Premium
  licence, a DLP policy, or a connection that needs re-authentication. Fix it and press Enter (or re-run).
- *Smoke test did not see a row*: the deploy succeeded but no run finished in time. Open the flow's run history.
- *Dashboard shows STALE*: the newest result is older than 3 x the interval. The flow is off, throttled or failing,
  or Power Platform itself is having an incident. Check the independent monitor.
- *Every target shows the same failure*: the flow's own outbound path or a policy is the likely cause, not Microsoft 365.
- Manual fallback if flow creation is rejected in your tenant: build a scheduled flow by hand with the actions
  listed in `DESIGN.md` ("The flow"), writing to `owatch_result`; the dashboard only needs the rows.

## Development

```
npm ci
npm test          # logic, golden cross-check, provisioning vs mock Dataverse, static script checks
npm run build     # tsc + vite
npm run dev       # dashboard with DEMO data at http://127.0.0.1:3000  (?sim=auth|exchange|slow|copilot|mixed, ?tenant=1, ?only=1, ?filter=power, ?collapse=all, ?demo=stale, ?theme=dark|light)
npm run plan      # same as -DryRun: print the provisioning request sequence
python3 tests/golden/gen_golden.py   # regenerate golden cases from the real outagewatch.py (needs ../outage-watch)
```

## Troubleshooting: first real-run report

**`POST EntityDefinitions(LogicalName='owatch_result')/Attributes: HTTP 400 An unexpected error occurred.`**
Seen on the first run against a real environment, while adding the first column to a table created a moment earlier.
Dataverse answers a metadata change that collides with another one with this generic error. Fixes now in the script:
after creating a table it waits until the table is readable and pauses 3 s; on this generic error it waits
(4, 8, 15, 25, 40 s), checks whether the column was actually created, and retries; only the generic 400 and 5xx are
retried (permission, validation and not-found errors are not). If it still fails after the retries the message
names the column, the Dataverse error code and the **request id** (send that id to Microsoft support / include it
when reporting). **Re-running the same command is always safe** and continues from where it stopped.
This fix is tested against the mock only; whether it resolves the real error is not confirmed until you re-run it.

**`GET owatch_settings: HTTP 400 [0x80060888] Could not find a property named 'owatch_value' on type 'Microsoft.Dynamics.CRM.owatch_setting'`**
Seen on the second real run (tables, 36 targets and the connection reference had already been created). The Web API keeps a
cached copy of the schema; right after a table or column is created it can say a column does not exist although it was
created. The script now (a) checks that the Web API can read every new column before it seeds anything and (b) retries the
settings reads while this specific error appears (waits 5-30 s, about 4 minutes in total). If it still shows after that, wait
a few minutes and re-run the same command. Tested against the mock only; not yet confirmed on a real tenant.
