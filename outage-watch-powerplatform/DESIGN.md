# Design notes - Outage Watch, Power Platform edition

## Architecture

```
 Recurrence (5 min)                      Dataverse (solution "OutageWatch")            Code app (browser)
 +--------------------------+   rows    +--------------------------------+   read     +------------------------------+
 | flow "Outage Watch-probe"| --------> | owatch_result  (RAW facts only)| ---------> | classify.ts  (pure, tested)  |
 |  List enabled targets    | <-------- | owatch_target  (what to probe) |            |  Monitor / Automation port   |
 |  For each: HTTP GET      |           | owatch_setting (interval, ...) |            | blast-radius map, roles,     |
 |   -> Record (always)     |           +--------------------------------+            | STALE banner, SIMULATION     |
 |  Prune old rows          |                                                         +------------------------------+
 |  Heartbeat (optional) ---+--> external dead-man's-switch URL (outside Microsoft)
 +--------------------------+
```

- **The flow is dumb.** It writes HTTP status, elapsed ms, the raw error code of the action, a timestamp and a round
  id. No column holds a state. A test asserts that (`tests/flow.test.ts`).
- **Judgement is client-side**, in one pure module (`src/logic/classify.ts`) that replays stored rounds through a
  port of `Monitor` and `Automation`. Changing a threshold re-judges history; nothing needs re-probing.
- **Provisioning logic lives in a zero-dependency Node helper** (`provision/`), not in PowerShell. Reason:
  PowerShell could not be run where this was built, Node could. The `.ps1` only does what needs Windows tooling
  (prerequisites, `pac`, sign-in, token, browser pages) and calls the helper; the helper's whole request sequence
  is exercised against a mock Dataverse over HTTP.

## Decisions and why

| Decision | Why |
|---|---|
| Tables/flow via the **Dataverse Web API**, not a hand-written solution zip | The Web API metadata and `workflows` routes are documented with JSON examples. A solution zip's `customizations.xml` written by hand, never exported from a real environment, is far more likely to be rejected, and `pac solution import` gives little to verify offline. Everything is still created **inside a solution** (`MSCRM.SolutionUniqueName`), so it can be exported, moved and removed as one unit. |
| Own publisher (`owatch_` prefix) | Avoids the default publisher's prefix, makes `-Purge` safe: only objects with this prefix are deleted. |
| Idempotency by "read, then create what is missing" | A re-run is an upgrade; a second identical run performs zero writes (tested). Seeded targets and thresholds are never overwritten, deployment settings (interval, retention) are. |
| Entity set names read back from metadata | The flow's `entityName` needs the entity set name; Dataverse chooses the plural. Not assumed. |
| Flow found by stored id, then by name | The id is kept in `owatch_setting`; falls back to `category eq 5 and name eq ...`. |
| Definition patched only when it differs, with the flow turned off first | Keeps re-runs quiet; avoids editing an active flow. |
| Token via `Az.Accounts` (`Get-AzAccessToken -ResourceUrl <org>`) | It is the route Microsoft documents for PowerShell + Dataverse Web API. `pac auth token` exists but its audience is described only as "Power Platform API"; no documented way to get an organisation token from `pac`. Cost: possibly a second sign-in. |
| Token only to allow-listed Dataverse hosts, `redirect: 'error'` | The org URL is parsed from `pac` output; it is validated against Dataverse host patterns before any request, and a bearer token is never re-sent to a redirect target. |
| Secrets through process environment variables | Never on a command line (visible in process lists and history), never in a file, never in output. |
| Heartbeat URL stored in the flow definition, secure inputs/outputs | Dataverse "secret" environment variables need Azure Key Vault (too heavy for zero-touch). In the definition it is readable only by flow owners/system admins and hidden from run history. Not in any table the dashboard reads. |
| Pruning inside the flow | Simple and visible. It costs one request per deleted row; a Dataverse bulk-delete job would cost none but was not implemented (unverifiable here). |
| Dashboard reads through `getClient().retrieveMultipleRecordsAsync` | Same proven pattern as the repository's existing code app (find the generated data source by primary key, not by its display name). Read-only. |
| States shown as shape + icon + word | Never colour alone; reduced motion respected; dark/light tokens from the Python dashboard. |

## The flow

`Recurrence` (Minute, interval N, concurrency 1) -> `Round` (Compose `utcNow()`) -> `List_targets` (Dataverse
ListRecords, `owatch_enabled eq true and statecode eq 0`) -> `For_each_target` (concurrency 20):
`Probe` (HTTP GET `owatch_url`, `retryPolicy: none`, `limit.timeout: PT10S`, `operationOptions: DisableAsyncPattern`,
no authentication, no body) -> `Record` (Dataverse CreateRecord; **runAfter Probe: Succeeded, Failed, Skipped,
TimedOut**) -> `Prune_list` (ListRecords older than retention, top 200; runs after the loop whatever its outcome)
-> `Prune_each` (DeleteRecord) ; `Heartbeat` (HTTP GET, only when a URL was supplied, only after the loop
Succeeded, secure inputs/outputs).

Recorded per probe: `owatch_httpstatus = outputs('Probe')?['statusCode']`, `owatch_elapsedms = (ticks(endTime) -
ticks(startTime)) / 10000` of the Probe action, `owatch_errorkind = ''` when the action Succeeded, else its `code`.

**Redirects.** The Python probe does not follow redirects ("a 302 is proof of life"). Microsoft's HTTP connector
documentation does not mention redirects at all and documents no setting to control them. Microsoft Q&A answers
state that the HTTP action treats a 3xx as a failed action and does not follow it. The design therefore does not
depend on either behaviour: whatever final status the action reports is stored; for targets without an alive list
any status below 500 except 429 is alive, so a recorded 302 **or** the 200 behind it both classify as up. Where it
would matter: a target with an explicit alive list (auth, exchange, graph) that starts redirecting shows as
`warning`, as in Python. The smoke test prints the recorded statuses so the real behaviour is visible on day one.

**Elapsed time** includes Logic Apps scheduling overhead and is measured from an Azure region, not from your
network. The warning rule compares each service with *its own* baseline, so the absolute offset does not matter.

## Documentation used

learn.microsoft.com was not reachable from the build sandbox; the pages were read from Microsoft's public source
repositories for those same pages (github.com/MicrosoftDocs). Canonical URLs:

| Topic | URL | Used for |
|---|---|---|
| Work with cloud flows using code | https://learn.microsoft.com/power-automate/manage-flows-with-code | `POST workflows` (category 5, type 1, primaryentity none, clientdata), `clientdata` envelope, connectionReferences (`runtimeSource`, `api.name`, `connectionReferenceLogicalName`), `statecode` 1 = on, PATCH/DELETE, "api.flow.microsoft.com isn't supported" |
| Create and update table definitions (Web API) | https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api | `POST EntityDefinitions` body, Label shape, primary name attribute, `MSCRM.SolutionUniqueName`, 204 + `OData-EntityId`, `PublishXml` |
| Create and update column definitions (Web API) | https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-update-column-definitions-using-web-api | `POST EntityDefinitions(LogicalName='..')/Attributes`; String / Integer / Boolean / DateTime bodies |
| Quick start: Web API with PowerShell | https://learn.microsoft.com/power-apps/developer/data-platform/webapi/quick-start-ps | `Connect-AzAccount`, `Get-AzAccessToken -ResourceUrl`, headers, `WhoAmI` |
| Workflow definition language: triggers and actions | https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers | Recurrence, Foreach + concurrency, Http inputs, `retryPolicy`, `limit.timeout` (`ActionTimedOut`), `operationOptions: DisableAsyncPattern`, `runtimeConfiguration` |
| Handle errors and exceptions | https://learn.microsoft.com/azure/logic-apps/error-exception-handling | default retry policy (408/429/5xx, 4 retries), `runAfter` statuses, shape of `result()`/`actions()` (code, status, startTime, endTime, outputs.statusCode) |
| HTTP built-in connector | https://learn.microsoft.com/azure/connectors/connectors-native-http | asynchronous pattern and how to disable it; **no statement on redirects** |
| Limits and configuration | https://learn.microsoft.com/azure/logic-apps/logic-apps-limits-and-config | 120 s outbound timeout, for-each concurrency 20 (max 50), minimum recurrence |
| Requests limits and allocations | https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations | "each trigger and action that runs counts as one request"; 40,000 / 6,000 / 250,000 per 24 h; transition period |
| pac code | https://learn.microsoft.com/power-platform/developer/cli/reference/code | `init --displayName`, `push`, `add-data-source --apiId --table`, `list` (preview) |
| pac auth / pac env / pac connection | https://learn.microsoft.com/power-platform/developer/cli/reference/auth , .../env , .../connection | `auth create --environment`, `auth who`, `auth token` (audience unspecified), `env select`, `env who`, `connection list`; `connection create` only takes a service principal |
| Code apps overview | https://learn.microsoft.com/power-apps/developer/code-apps/overview | "Enable code apps" admin setting, Power Apps Premium for end users, no API for the setting |
| Code apps: connect to Dataverse | https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse | supported: retrieve multiple with select/filter/orderBy/top; unsupported: FetchXML, alternate keys, metadata CRUD |
| Microsoft Q&A threads on HTTP 302 in Logic Apps | https://learn.microsoft.com/en-us/answers/questions/1454926/ , .../2127782/ , .../1611262/ | redirect behaviour (community/moderator answers, not reference documentation) |

## Unconfirmed - could NOT be confirmed from documentation, or not tested

Nothing in this folder has been run against a real tenant. Specifically:

1. **PowerShell script never executed** (no PowerShell in the sandbox). Only static checks.
2. **`pac` never executed.** Output parsing of `pac auth who` (tenant id), `pac env who` / `pac org who` (org URL),
   `pac connection list` (connection id; regex reused from the existing script) and the "pushed successfully" /
   `ApplicationDisplayNameIsInUse` handling (reused) depend on pac's text output, which is not specified.
3. **Flow `clientdata` beyond the documented example.** The official example shows only a `ListRecords` action.
   The `CreateRecord` (`item/<column>`) and `DeleteRecord` (`recordId`) parameter names follow what the designer
   writes, not documentation. Whether Power Automate accepts `limit.timeout`, `operationOptions`,
   `runtimeConfiguration.secureData` and trigger concurrency exactly as Logic Apps documents them is assumed.
   Hand-written `clientdata` is the most brittle part of this deliverable; if the service rejects it the script
   reports the message, leaves tables and data intact, and the README describes the manual fallback.
4. **HTTP action and redirects**: see above; undocumented.
5. **What a failed probe looks like**: whether a DNS/TLS/timeout failure yields a null `statusCode` or a
   synthesized 502/504, and the exact `code` strings. Both forms classify as "down", so the result is the same.
6. **`blocked` state**: which error code the HTTP action reports when a policy (DLP endpoint filtering, IP
   firewall) refuses a request is undocumented. Only the exact kinds `proxy-denied` / `blocked` map to `blocked`;
   in practice a policy block will appear as `down` for every target (the README says how to read that).
7. **Connection reference rows** (`connectionreferences`: logical name, connector id, connection id) and
   **publisher/solution rows**: standard Web API creates, written from the table reference, not from a walkthrough.
8. **Patching `clientdata` of an existing flow** and turning a flow off/on through `statecode`: update and
   `statecode: 1` are documented; `statecode: 0` and the off-patch-on sequence are assumed.
9. **Code apps enabled?** No documented API. The script runs `pac code list` and looks for a "disabled" message
   (wording unknown); the real test is `pac code push`. The admin-center deep link it opens is a best guess; the
   click path is printed too.
10. **`pac code add-data-source -a dataverse -t <table>`** is reused from the existing, working script; the current
    docs describe a newer npm-based CLI (`pa app add data-source --connector dataverse --table`). If pac drops the
    old form the dashboard step fails (tables and flow stay deployed).
11. **Row volume in the dashboard**: `top: 5000` on `retrieveMultipleRecordsAsync`; paging limits of the SDK
    were not confirmed. 8 hours at the defaults is 1,440 rows.
12. **First run timing**: the smoke test assumes a Recurrence flow runs shortly after being turned on; otherwise
    it reports "not confirmed yet" after the wait, without failing the deployment.
13. **Deep links** to the flow details page and the "new connection" page (the latter reused from the existing script).
14. **Read access for non-admin viewers** needs a security role on the custom tables; not created by the script.
15. **Licence enforcement**: whether activation fails immediately without Power Automate Premium, or the flow turns
    on and its runs fail later, was not observed. The smoke test covers the second case.

## Test map

| File | Proves |
|---|---|
| `tests/golden.test.ts` + `tests/golden/golden.json` | TS port == real Python (`gen_golden.py` runs `outagewatch.py`) |
| `tests/classify.test.ts`, `tests/graph.test.ts` | flow-specific raw cases, frame replay, STALE rule, blast radius, roles, layout at 360 px |
| `tests/provision.test.ts` | request sequence, idempotency, resume, upgrade, failures, uninstall/purge, CLI exit codes (mock Dataverse over HTTP) |
| `tests/flow.test.ts` | clientdata envelope, run-after, no retries, dumb flow, heartbeat, usage estimate, metadata payloads |
| `tests/validate.test.ts` | GUID (incl. the `.ps1` literal), org-URL allow-list, tenant, heartbeat URL, hostile input |
| `tests/ps1-static.test.ts` | `.ps1` balanced, PS 5.1-compatible syntax, ASCII, no secrets printed, `.cmd` wrappers |
