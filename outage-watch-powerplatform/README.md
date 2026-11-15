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

**Status.** The author of this folder had no tenant and no PowerShell: nothing here was run by its author against
a real environment. The user reports that, after three fixes (see "Troubleshooting: first real-run report"), the
deployment of tables, 36 targets, probe flow and dashboard now completes on their tenant. **Everything added after
that - Teams / Slack / Webex alerts, incident records, the CI gate and the agent definition - has never run on a
real tenant**; it is tested against a mock Dataverse and a workflow interpreter only. `DESIGN.md` lists every
unconfirmed item.

## What gets deployed

| Piece | What it is |
|---|---|
| Dataverse solution `OutageWatch` (publisher prefix `owatch_`) | tables `owatch_target` (name, URL, alive codes, depends-on-sign-in, Copilot-needs-it, enabled, family), `owatch_result` (target, HTTP status, elapsed ms, error kind, time, round) and `owatch_setting` (name/value, no secrets) |
| 36 seeded targets in 9 families | the same services, URLs, alive-code rules, dependencies and families as `outagewatch.py` (checked by a test against the real Python). 34 are probed out of the box. `sharepoint-online` and `onedrive-business` are tenant-specific: with `-TenantName contoso` they are probed; without it they are seeded **disabled, with no URL**, never probed, and shown as the neutral **unconfigured** state - never a failure |
| Cloud flow `Outage Watch - probe` | every 10 min: unauthenticated `GET` on every enabled target, **all in parallel** (no retries, 10 s timeout, async polling off), **one raw row per probe**, prune rows older than the retention, optional heartbeat ping. The flow never decides whether something is "up" |
| Connection reference `owatch_dataverse` | binds the flow to your Microsoft Dataverse connection |
| Cloud flow `Outage Watch - alert` (only when a channel is configured) | tells Teams / Slack / Webex / a webhook when a service fails, keeps failing or recovers; keeps incident records (`owatch_incident`) and the CI status row. Separate from the probe flow on purpose |
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
                         [-TeamsChannelLink <link>] [-SetSlackWebhook] [-SetWebexWebhook] [-SetAlertWebhook]
                         [-RemoveChannels slack,webex] [-NoAlerts] [-SendTestAlert]
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

## Alerts (Teams, Slack, Webex), incidents, CI gate, agents

**Status of this whole section: built and tested against a mock and an interpreter here; never run on a real
tenant.** The probe flow and dashboard deploy on a real tenant; the alert flow, its Teams action, the webhook
posts, the incident table, the CI row and the agent definition have not been tried there yet. If the alert flow is
rejected the deployment still completes and says exactly why alerts are not active; probing is never affected.

A second flow, **Outage Watch - alert**, runs at the same interval as the probe flow. It needs no open dashboard.

| What | How |
|---|---|
| When | A service is *failing* when its newest probe had no HTTP answer, HTTP 5xx, 429, or (if the target lists alive codes) a status outside the list. Disabled / unconfigured targets never alert. An incident is announced after `alert_confirm` failed rounds in a row (default 2). |
| Messages | **One per round**, grouped by family: NEW FAILURE, STILL FAILING (every `alert_reminder_minutes`, default 60), RECOVERED (with downtime). Per service: name, family, URL, HTTP status or "no HTTP answer", elapsed ms, **the error** (code + text of the failed HTTP action or the start of the error response, max 300 characters), failing since, consecutive failures, last successful round. Header: time, round, counts, services at risk when sign-in fails, the Copilot-underneath note, the dashboard link if known, and the same-fate warning. At most 10 services in detail, then "and N more". |
| Channels | **Teams** (Teams connector, as Flow bot), **Slack** (incoming webhook), **Webex** (incoming webhook), **any webhook** that accepts `POST {"text": ...}`. Same text everywhere, encoded safely per channel (HTML-escaped for Teams; `&<>` escaped for Slack so no mention or link can be injected; plain text for Webex). Each channel is independent: one failing never blocks another, and its last result is shown on the dashboard. |
| State | Per target, in new columns of `owatch_target`: no duplicates across runs or restarts; each probe round is judged at most once. |
| Incidents | Table `owatch_incident`: failing since, recovered at, duration, failed rounds, reminders, first error. Shown on the dashboard; queryable for MTTR. |
| CI gate | Setting `ci_status`: `ok` / `caution` / `freeze` with since-when and the failing services. See `ci/` (gate script, GitHub Actions, Azure DevOps, PowerShell, curl). |
| Agents | `agent/openapi.json`: three read-only operations for an AI agent. **Unconfirmed** in Copilot Studio; see `agent/README.md`. |

### "I deployed it and see no Teams / Slack / Webex integration"

That is expected until a channel is given: **alerts are off by default**. The alert flow, the Teams connection
reference and the incident history are only created when at least one channel is configured. Since this version
the script asks for the channels in one guided step, the summary ends with a loud `ALERTS ARE OFF` block with the
exact command, and the dashboard panel "Alerts, CI gate and incidents" shows the same commands.

**How to see it worked** (after a run with a channel):

1. Summary of the script: `Alerts      : ON to teams, slack` and the names of what was created.
2. Power Automate (make.powerautomate.com) > **Solutions** > **Outage Watch** > **Cloud flows**: a second flow
   **Outage Watch - alert**, status On, next to "Outage Watch - probe". (Solution flows are not under "My flows"
   in every view: look in the solution.)
3. For Teams: the same solution > **Connection references**: **Outage Watch - Teams** (`owatch_teams`), connected.
   **Slack and Webex have no connection or connector to look for**: they are incoming *webhooks* called by an HTTP
   action inside the alert flow, so nothing appears under Connections.
4. Run with `-SendTestAlert`: within one probe interval (10 minutes by default, plus up to 2 minutes) a message
   that starts with "TEST - Outage Watch alert test" arrives in every channel.
5. Dashboard > "Alerts, CI gate and incidents": each channel shows "delivered <time>" or the failure.

If step 4 brings nothing: open the run history of "Outage Watch - alert" and see Troubleshooting > Alerts. None of
this was observed on a real tenant by the author.

### Set it up

```
Deploy-OutageWatchPP.cmd <environment-id> -TeamsChannelLink "<link>" -SetSlackWebhook -SetWebexWebhook -SendTestAlert
```

- **Teams**: in Teams, hover the channel name > **...** > **Get link to channel** > Copy. Pass it with
  `-TeamsChannelLink`, or just run the script and paste it when asked (Enter skips). The script checks the link,
  finds your Microsoft Teams connection (or opens the page to create it and waits), and binds it. Use a
  **standard channel**; the account of the connection must be a member of the team. Private channels are not
  supported by this Teams action (Microsoft's documentation); shared channels are unconfirmed.
- **Slack**: create an *Incoming Webhook* for the channel in Slack and run with `-SetSlackWebhook`: the URL is
  asked with hidden input. **Webex**: add the *Incoming Webhooks* integration to the space, run with
  `-SetWebexWebhook`. Any other tool: `-SetAlertWebhook`.
- Unattended (`-Yes`): `OUTAGEWATCH_SLACK_WEBHOOK`, `OUTAGEWATCH_WEBEX_WEBHOOK`, `OUTAGEWATCH_ALERT_WEBHOOK`
  environment variables; `-TeamsChannelLink` as a parameter (a channel link is not a secret). With `-Yes` and no
  channel at all, alerts stay unconfigured and the summary says so.
- **Test**: `-SendTestAlert`, or set the setting `alert_test` to `yes`: a clearly labelled TEST goes to every
  channel within one interval and the flag resets. **Mute**: setting `alert_snooze_until` = a UTC time such as
  `2026-12-31T18:00:00Z` (probing, incidents and the CI status continue). **Silence one channel**: setting
  `alert_channels_off` = `slack,webex`. **Change channel**: re-run with the new link / flag. **Remove**:
  `-RemoveChannels slack`. **Stop**: `-NoAlerts`. Channels are kept between runs unless you change them.

**Where the webhook URLs are kept.** A webhook URL is a credential. It is never a command-line value, never
printed, never written to a table, a setting, the dashboard or the summary. It is stored in one place: the
definition of the alert flow, on an HTTP action with secure inputs and outputs (so it stays out of the run
history). Trade-off: flow owners / co-owners and system administrators can read it there. Dataverse "secret"
environment variables backed by Azure Key Vault would be stronger; they need a Key Vault and could not be
verified here, so they are not used. For a failed webhook delivery only the HTTP status is recorded, never the
error text (which could repeat the URL).

**Same-fate, again.** The alert flow is a Power Automate flow; Teams is Microsoft 365. In a Microsoft 365 or Power
Platform outage an alert may be late or never arrive, and the first line of every message's footer says so. Slack
and Webex are outside Microsoft but the message is still *sent by* Power Automate. The external heartbeat
(`-SetHeartbeat`) and the independent Python monitor, which can alert to non-Microsoft channels from outside, are
the safety nets.

**Not built** (asked for, left out rather than faked): scheduled digest, maintenance windows (use
`alert_snooze_until`), automatic ticket creation, escalation to a second channel, per-channel severity/family
filters, a Slack/Webex connector route (webhooks were chosen), an MCP server, Key Vault secrets.

## Insights (explainable checks, computed in the browser)

"Insights" are deterministic rules applied to rows the dashboard already loaded. No model, no prediction, **no
extra flow runs and no extra quota**. Each one prints the numbers it used; none of them changes the level.

| Insight | Rule | Shows |
|---|---|---|
| **Probable common cause** | In order: nearly everything failing (>= 80% of at least 5 probed) -> the probe path; sign-in failing -> sign-in; Copilot failing with a service it reads -> that service; >= 3 failures with >= 60% in one family -> that family. Otherwise nothing is claimed. | The statement, its evidence (counts, which services), and what the probes cannot know. The alert message leads with the same statement when sign-in fails. |
| **Drifting** | Median of the last 6 answered probes is at least `drift_percent` (50) % **and** `drift_min_ms` (150) ms above the median before, while still "up". | "teams: last 6 answers median 420 ms vs 180 ms before (+133%)". Advisory only. |
| **Flapping** | `flap_changes` (4) or more changes between answering and failing in the last 12 rounds. | The service and the count. |
| **Scorecard** | Share of probe rounds answered, p50 / p95 latency, per family and worst services. **Only for the loaded window (12 hours)**: the browser does not load 30 days of rows. | Table. |
| **Incident statistics** | From the incident table, last 30 days: count, mean time to recover, repeat offenders (2+ incidents), alert messages per week and the share that were reminders, plus a noise hint when the data supports one. | Numbers and the hint with its number. |
| **Post-incident report / staff update** | Built from the incident records only: timeline, scope by family, duration, recovery order, error themes (ids, numbers and times removed so equal errors group), what the facts can and cannot say. | "Copy" (clipboard) and "Download .md"; a draft staff update. |
| **Impact estimate** | Setting `impact_headcount`, e.g. `Email & calendar=240; Meetings=300`. | "about 240 people use this (admin-supplied figure)". Without the setting, no number is shown: none is ever invented. |

Try them without an outage: **Simulation** > "Sign-in outage", "Flapping Exchange", "Slow drift", "Several at once".

**Asked for and NOT built** (left out rather than faked): time-of-week baselines (would need a week or more of
rows per service in the browser, or server-side aggregation); flap suppression inside the alert flow; 7-day /
30-day scorecards; per-channel severity and family routing; escalation to a second channel; scheduled digests;
maintenance windows (use `alert_snooze_until`); acknowledge (the dashboard is read-only; the Teams "post card and
wait" route was not verified and would hold a flow run open); ticket creation; a Copilot Studio agent package.

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

**With alerts on, add the alert flow:** about 25 requests per run when nothing is failing = **3,600/day** at 10
minutes. Default total (34 targets, 10 minutes, alerts on): **19,152 requests/day = 48% of 40,000** (36 targets:
20,016 = 50%). While something fails, each failing service adds about 10 requests per run, and each posted message
about 10 plus 3 per channel: a day with 5 services down all day and hourly reminders costs roughly 7,500 more
(about 67% in total) - still inside one licence, and exactly the day you want the monitor to keep running. At 5
minutes with alerts the quiet-day total is 38,304 (96%): do not combine a 5-minute interval with alerts on one
Premium licence. Unconfirmed: whether a Teams post or a skipped branch is counted differently; the figures count
every action that runs once.

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
`recover_after`) are rows in `owatch_setting`; targets are rows in `owatch_target`. Edit them in the maker portal; a
re-deploy never overwrites your edits. The "Can I do my job?" list is built into the dashboard and is **not** stored
in Dataverse. To override it, add a setting row named `roles_json` with JSON like `{"Payroll":["auth","graph"]}`; a
setting value holds 400 characters, so continue a longer list in `roles_json_2`, `roles_json_3`, ... (joined in order).

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

Verified here (`npm test`, 267 tests; `npm run build`; headless Chromium):

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

**Not verified here:** nothing in this folder was run against a tenant by its author. From the user's three real
runs it is known that sign-in, table/column creation, seeding 36 targets, the connection reference and flow
*creation* work; turning the flow on, a flow run, the code-app publish and the smoke test have never been observed,
and the fixes made after each run are tested against the mock only. The mock Dataverse is a model written from the
documentation and from the three observed errors, not Microsoft's implementation. Every value written to a table is
also checked against the column limits (the mock enforces them; added after the third run).

### Alerts, incidents, CI gate: how they were verified

- A plain-JavaScript reference of the decision logic (`provision/lib/alert-logic.mjs`: failure rule, confirm,
  open / reminder / recovered, dedupe, snooze, message text, per-channel encoding, CI status) is unit-tested.
- The **generated flow definitions are executed** by a small interpreter of the workflow language
  (`tests/helpers/wdl.mjs`) against the mock Dataverse: probe rounds and alert runs, compared with the reference
  at every step, including a seeded 60-round fuzz with setting changes and channel outages, hostile names and
  error texts, 34 services failing at once, missing bookkeeping rows. The interpreter is this project's reading of
  the documented language (strict where the real engine is known to be strict, e.g. `if()` evaluates both
  branches); it is **not** Microsoft's engine.
- Upgrade from the deployed version (commit 24090f5, using that commit's real flow definition): table, columns and
  settings added, probe flow updated in place, 36 targets and all results untouched, idempotent.
- Column limits: every value either flow writes is bounded and the mock rejects anything too long.
- The CI gate script against the mock; the pipeline YAML and the PowerShell gate were **not** run.
- **Not verified at all:** the Teams action on a real tenant (its operation id and parameter names are not in
  Microsoft's reference documentation), how the message renders in Teams / Slack / Webex, real webhook delivery,
  flow activation with a Teams connection reference, real request consumption, the agent definition in any agent
  platform.

### Insights: how they were verified

`tests/insights.test.ts` (22 tests): every rule with its evidence text, thresholds at their boundaries, hostile
service names, a 100,000-character error text, empty and tiny history, unreadable and future-dated incident rows.
The report is checked to be deterministic and to keep its Markdown structure under hostile input. The panel was
rendered at 360, 390, 412 and 1440 px, dark and light, with no console error and no horizontal overflow; copying
to the clipboard was exercised in headless Chromium. **Not verified:** clipboard and file download inside the
real Power Apps player (embedded frames may block either; the text is always also shown in a box to copy by
hand), rendering on real iOS Safari / Android Chrome (only Chromium at phone widths), and whether the default
drift and flap thresholds suit real Microsoft 365 latency patterns (they are settings for that reason).

## Manual steps that remain

1. Have code apps enabled and the licences assigned (admin, once).
2. Run the command; sign in / click "Create" if prompted.
3. Open the dashboard URL from the summary and approve the connection prompt.
4. For other viewers: share the app, and give them a security role with **Read** on the three `owatch_` tables
   (the script does not create a role).
5. Recommended: `-SetHeartbeat`, and keep the independent Python monitor running elsewhere.
6. For alerts: paste the Teams channel link when asked (and click "Create" once for the Teams connection), and/or
   enter the Slack / Webex webhook URLs at the hidden prompts. Then check the TEST message arrived (`-SendTestAlert`).

## Troubleshooting

- *Flow created but OFF*: the script prints Power Automate's message and opens the flow. Usual causes: no Premium
  licence, a DLP policy, or a connection that needs re-authentication. Fix it and press Enter (or re-run).
- *Smoke test did not see a row*: the deploy succeeded but no run finished in time. Open the flow's run history.
- *Dashboard shows STALE*: the newest result is older than 3 x the interval. The flow is off, throttled or failing,
  or Power Platform itself is having an incident. Check the independent monitor.
- *Every target shows the same failure*: the flow's own outbound path or a policy is the likely cause, not Microsoft 365.
- Manual fallback if flow creation is rejected in your tenant: build a scheduled flow by hand with the actions
  listed in `DESIGN.md` ("The flow"), writing to `owatch_result`; the dashboard only needs the rows.

### Alerts

- *Summary says "Alerts: NOT ACTIVE"*: the service refused the alert flow; its message is printed above the summary.
  Most likely the Teams action definition (unconfirmed on a real tenant) or a DLP policy. Probing is unaffected.
  Workaround until fixed: use Slack / Webex / webhook (`-RemoveChannels teams`), or build the Teams post by hand
  in the flow designer.
- *No TEST message*: open the dashboard panel "Alerts, CI gate and incidents": each channel shows its last delivery
  or the error. Then the run history of "Outage Watch - alert" in Power Automate.
- *Teams: "last delivery FAILED"*: the connection's account is not a member of the team, the channel is private, or
  the Power Automate app is blocked in Teams. *Slack / Webex: "FAILED HTTP 404/410"*: the webhook was revoked;
  create a new one and re-run with `-SetSlackWebhook` / `-SetWebexWebhook`.
- *Alerts stopped but services still fail*: check `alert_snooze_until`, `alert_enabled`, `alert_channels_off`.
- *CI gate says STALE*: the alert flow is off or failing (the row is rewritten every judged round), or no channel is
  configured (then the alert flow is not deployed at all).

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

**`POST owatch_settings: HTTP 400 [0x80044331] ... The length of the 'owatch_value' attribute of the 'owatch_setting' entity exceeded the maximum allowed length of '400'`**
Seen on the third real run, at step [7/8], after the flow had been created. Cause: a bug in this tool, not in your
environment. It tried to store the "Can I do my job?" list as a setting (`roles_json`); with 11 tasks that JSON is 618
characters and the setting column holds 400. Fix: the list is no longer stored at all (the dashboard has it built in),
so no column is changed and nothing has to be deleted. **Just re-run the same command**: tables, targets, connection
reference and the flow are found and reused; the run stores the flow id, turns the flow on and continues. Every row
the tool writes is now checked against its column limits before it is sent, and the flow cuts unbounded runtime
text (error codes, names) to the column length. Tested against the mock, which now enforces the same limits and
returns the same error; not yet confirmed by a real re-run.
