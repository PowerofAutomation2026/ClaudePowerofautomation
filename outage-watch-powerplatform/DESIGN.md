# Design notes - Outage Watch, Power Platform edition

## Architecture

```
 Recurrence (10 min)                     Dataverse (solution "OutageWatch")            Code app (browser)
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
| Tenant-specific targets without a tenant name = a row with **no URL, disabled** | No schema change, and safe by construction: the flow's filter (`owatch_enabled eq true and owatch_url ne null`) can never probe it. The dashboard turns "no URL" into the neutral `unconfigured` state; "URL but disabled" means an admin switched it off and it is hidden. |
| Renamed targets migrated by renaming the **row**, history by an alias in the dashboard | `sharepoint`/`onedrive` rows are PATCHed to the new names (same row id, URL, enabled flag). Rewriting thousands of result rows would cost thousands of requests for data that expires in days; the dashboard maps old names to new when reading (`shared/catalog.json` "renamed"). |
| Default interval 10 min (was 5) | 34 targets at 5 min = 31,104 requests/day = 78% of 40,000. 10 min = 15,552 = 39%. Slower detection is the price; stated in README, `-DryRun`, and a WARNING above 60%. |
| "For each" concurrency 50 (documented maximum) | All 36 probes start together: worst-case round is about one timeout (10 s), not 36 (6 min). Trigger concurrency 1 prevents overlap. |
| Family layout: bands on two buses, no per-edge lines | 36 nodes have 30 sign-in edges and 6 Copilot edges; drawn individually they are unreadable. Each family is a band; a left rail carries "needs sign-in", a right rail "Copilot reads". Rows order sign-in dependants first so a rail never crosses a service it does not belong to (tested). |
| Alerts in a **separate** flow | A Teams / webhook problem can never stop or slow probing; a flow cannot be turned on with an unbound connection, and probing must not depend on Teams; the deployed probe flow changes minimally. Cost: about 25 requests per quiet run. If the service rejects the alert flow the deployment still succeeds and reports it. |
| One raw failure flag (`owatch_failed`) and the error text (`owatch_errormessage`) written by the probe flow | The alert flow cannot run the dashboard's TypeScript. With the flag it lists only failed rows of a round (one cheap query) instead of re-deriving failure for every target. The flag is the same rule as `isFailure()`; the dashboard still classifies on its own. |
| Alert state in columns of `owatch_target`; each round judged at most once (`alert_last_round` saved BEFORE judging) | No duplicates across runs or restarts. A run that fails after saving loses that round's judgement (counts lag by one round) rather than double-counting. |
| Loop only over targets that fail now, are in a streak, or have an open incident | Normally zero iterations: quiet cost is constant, not per target. |
| Datetime columns always written with a real value (sentinel 2000-01-01), never null | Whether the Dataverse connector accepts null for a datetime/integer parameter is unconfirmed; the logic never depends on clearing a column (the failure count is the source of truth). |
| One plain-text message, encoded per channel | One template to get right. Teams: whole text HTML-escaped, newlines to `<br>` (so no markup can be injected, at the price of no bold); Slack: `&<>` escaped; Webex / webhook: plain `text`. Caps: 10 detailed services, 300 characters of error, Teams 16,000 escaped characters, Slack 12,000, Webex 3,500 (its limit is 7,439 bytes). |
| Slack and Webex through **incoming webhooks** (HTTP action), Teams through the **Teams connector** | Incoming webhooks are the simple, documented route for both and need no connector connection. The HTTP action is premium, but the flow owner already needs Premium for the probe flow. The Slack / Webex connectors were not used: their operation ids in a flow definition could not be confirmed. |
| Webhook URLs only inside the flow definition, secure inputs/outputs; status of a failed webhook = HTTP status only | See README "Where the webhook URLs are kept". Key Vault-backed secret environment variables were not verifiable here. |
| CI / agent status = one setting row rewritten every judged round, read through the Web API | Documented, no extra flow, no HTTP-trigger URL (which would be a bearer secret) and no premium trigger. Its `updated` time doubles as a liveness signal; the gate fails closed on stale data by default. |
| Incidents per service, in their own table | Matches the per-target state; open / remind / close are single-row operations found by name + open flag. |
| Insights computed in the browser, on the already loaded window | No flow runs, no quota, no tenant risk; rules can be read and tested as plain TypeScript (`src/logic/insights.ts`). Price: they only see what the dashboard loaded (12 hours of results, 200 incidents). Anything needing weeks of rows (time-of-week baselines, 30-day uptime) was not built instead of being approximated. |
| "Probable common cause" is a fixed ordered rule list, never a cause label from elsewhere | Early vendor root causes get revised; the monitor only states what its probes saw and always prints the evidence and the limits. The alert flow uses the same wording for the sign-in case (reference and flow compared in tests). |
| Alerts are opt-in, and the script, summary and dashboard now say so loudly | The first real deployment had no channel and nothing made that visible. |
| SharePoint tenant name is detected and VERIFIED, never guessed | Zero-touch coverage of SharePoint / OneDrive. Candidates come from PowerShell (Az domains, Graph); the decision is in `provision/lib/tenant.mjs` so it is testable. A candidate is used only if its host answers like an existing tenant; two answering candidates = no choice; 404 is rejected on purpose. Detection can never fail the deployment and never prompts with `-Yes`. |
| `sharepoint-admin` is a Power Platform-only target (`ppOnly` in the catalog) | The Python catalogue has two tenant targets; the golden cross-check still compares the shared ones exactly and names the extra one explicitly. No other SharePoint / OneDrive endpoint was added: nothing else could be justified from documentation or observed here. |
| Tenant rows are filled only in their untouched seed state (no URL and not enabled) | An upgrade must never overwrite an admin's edit. |
| Pruning inside the flow | Simple and visible. It costs one request per deleted row; a Dataverse bulk-delete job would cost none but was not implemented (unverifiable here). |
| Dashboard reads through `getClient().retrieveMultipleRecordsAsync` | Same proven pattern as the repository's existing code app (find the generated data source by primary key, not by its display name). Read-only. |
| States shown as shape + icon + word | Never colour alone; reduced motion respected; dark/light tokens from the Python dashboard. |

## The flow

`Recurrence` (Minute, interval N, concurrency 1) -> `Round` (Compose `utcNow()`) -> `List_targets` (Dataverse
ListRecords, `owatch_enabled eq true and owatch_url ne null and statecode eq 0`) -> `For_each_target` (concurrency 50):
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

Added for alerts (same caveat: read from the MicrosoftDocs sources or via search, learn.microsoft.com itself was not reachable):
https://learn.microsoft.com/power-automate/teams/send-a-message-in-teams (action name, poster / location options, private
channels unsupported); https://learn.microsoft.com/connectors/teams/ (Flow bot not in government clouds; via search only).
Slack incoming webhooks (https://api.slack.com/messaging/webhooks) and Webex incoming webhooks
(https://apphub.webex.com/applications/incoming-webhooks-cisco-systems-38054-23307-75252) are cited from memory, **not fetched**.

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
    were not confirmed. 12 hours at the defaults is 2,592 rows (36 targets, 72 rounds).
12. **First run timing**: the smoke test assumes a Recurrence flow runs shortly after being turned on; otherwise
    it reports "not confirmed yet" after the wait, without failing the deployment.
13. **Deep links** to the flow details page and the "new connection" page (the latter reused from the existing script).
14. **Read access for non-admin viewers** needs a security role on the custom tables; not created by the script.
15. **Licence enforcement**: whether activation fails immediately without Power Automate Premium, or the flow turns
    on and its runs fail later, was not observed. The smoke test covers the second case.

16. **Empty URL = null.** Unconfigured targets are created with `owatch_url: ""`; Dataverse is assumed to store
    that as null and the connector to honour `owatch_url ne null`. Even if the filter behaved differently the row
    is also disabled, so it is still not probed.
17. **50 parallel HTTP actions.** 50 is the documented concurrency maximum; whether Power Automate or the probed
    hosts throttle 36 simultaneous anonymous requests from one flow run was not observed. A throttled probe would be
    recorded as HTTP 429 = failed, i.e. visible, not silent. Lower `PROBE_CONCURRENCY` in `provision/lib/flow.mjs` if so.
18. **Renaming a row's primary name by PATCH** (`owatch_name`) is an ordinary column update; not run for real.
19. **The 21 added service URLs** come from `outage-watch/outagewatch.py` (its README lists the sources). They were
    copied, and checked equal by a test, but not probed from a flow: which status each returns to an anonymous
    request from Azure (and whether any consistently answers 5xx/429 to datacentre addresses) is unknown until the
    first real run. The smoke test prints the recorded statuses.
20. **Golden cases** were generated from `outage-watch/` at commit `4776649`; if the Python changes again,
    `gen_golden.py` must be re-run (the catalogue test then fails loudly, by design).
21. **Request counting**: the estimate assumes a "for each" action and each iteration's actions count once each and
    that the trigger counts; Microsoft's wording is "each trigger and action that runs". Real consumption is visible
    in the Power Platform admin center and may differ by a few percent.

22. **`actions('Probe')` inside the "for each".** The Record action reads `actions('Probe')?['status' | 'code' | 'startTime' | 'endTime']`
    of the current iteration. That is how the workflow language documents `actions()`, but nobody has seen this flow run. If it misbehaves,
    the symptom is visible in the run history (Record fails or writes empty error kind / zero elapsed), not silent.
23. **Null into an Integer column from the connector.** For a probe without an HTTP answer the flow passes `null` as `owatch_httpstatus`.
    Assumed to leave the column empty. If the Dataverse connector rejects it, Record fails for exactly the probes that matter most
    (visible in run history; the dashboard would then show STALE for those targets rather than "down").
24. **`statusCode` is an integer.** Documented in the `result()` example (`"statusCode": 404`); the column accepts 0..999, HTTP uses 100..599.
    It is not converted or clamped by the flow.
25. **Expression functions used to bound values** (`take`, `string`, `max`, `min`, `div`, `sub`, `ticks`, `coalesce`, `if`, `equals`, `addDays`,
    `utcNow` with a format string) are standard workflow-language functions; their exact behaviour on null input (`string(null)`) was not run.
    Dataverse accepted the definition at creation, which checks syntax, not runtime behaviour.
26. **Activation (`PATCH workflows(id) {"statecode": 1}`)** is the documented way to turn a flow on, and is the next step no real run has reached.
27. **Dashboard after the fix**: with no `roles_json` row the built-in list is used; with an old 7-role row left by a 15-target deployment the
    provisioner deletes it. A dashboard build older than this fix reading a tenant without the row also falls back to its built-in list.

28. **Teams action.** `PostMessageToConversation` with `poster`, `location`, `body/recipient/groupId`, `body/recipient/channelId`,
    `body/messageBody` is what the designer writes for "Post message in a chat or channel"; it is not in Microsoft's reference
    documentation and was not run. Microsoft documents: Flow bot or User as poster, Channel as location, **private channels not
    supported**; Flow bot is not available in government clouds (connector page, via search). Shared channels, required team
    membership and the "Flow bot cannot be installed" case are unconfirmed.
29. **Rendering.** How Teams renders `<p>` + `<br>` with emoji in the title, how Slack shows a long `text`, and whether Webex
    incoming webhooks accept a `text` field (the Messages API does; the webhook integration documents `markdown`/`text`) were not
    observed. Message size limits used: Teams about 28 KB, Slack 40,000 characters, Webex 7,439 bytes (from memory of the vendor
    documentation; not re-read here).
30. **Workflow-language behaviour assumed by the alert flow**: `actions()` / `outputs()` of an action inside the same loop
    iteration; variables in a sequential "for each"; `Query` (Filter array) and `Select` shapes; `If` with an object expression;
    `first()` of an empty array = null; string comparison with `greater()`; `decodeUriComponent('%0A')` as newline; `split`, `last`,
    `isInt`; outputs of a secured HTTP action usable by the next action; a failed action handled by a later run-after leaves the
    run successful. The test interpreter implements these as documented/understood; none was run on Power Automate.
31. **Dataverse connector operations** `UpdateRecord` (parameters `recordId`, `item/<column>`) and `ListRecords` with `$orderby`
    on two columns: designer conventions, not reference documentation.
32. **Text comparison of round ids** in an OData filter (`owatch_round lt '...'`) relies on Dataverse comparing strings
    ordinally-enough for fixed-width digits; and `owatch_name eq '...'` with doubled apostrophes.
33. **Request counting** for the alert flow (25 per quiet run): assumes scopes (`If`, `Foreach`), data operations and variable
    actions each count once and skipped actions do not.
34. **CI snippets and agent definition**: `azure/login` + `az account get-access-token --resource <org>` for an application user
    is the standard pattern but was not run; the PowerShell gate was not executed; `agent/openapi.json` was not imported anywhere.
35. **Upgrade of the live probe flow definition** (turn off, patch `clientdata`, turn on) is exercised only on the mock; it is
    needed for the two new columns to be written. If the patch is rejected the probe flow would stay OFF: the script reports the
    error; turn it back on in Power Automate (the old definition keeps working) and report the message.

36. **Clipboard / download in the Power Apps player.** `navigator.clipboard.writeText` and a Blob download link work in a normal
    browser tab (tested in headless Chromium); inside the code-app host frame either may be blocked by permissions policy. The
    generated text is always also placed in a read-only box.
37. **Community scan.** The feature choices cite a scan of public pages supplied to the author (no vote counts). Nothing in this
    folder claims a feature is new or unique; no competing product was examined.
38. **Insight thresholds** (drift 50% and 150 ms over 6 probes; flapping 4 changes in 12 rounds; 80% / 60% in the common-cause
    rules) are reasoned defaults, not calibrated on real data.
39. **Guided channel prompts in the script** (four `Read-Host` questions, three hidden) are statically checked only.

40. **`Get-AzTenant -TenantId <id>` `.Domains`** contains the `<name>.onmicrosoft.com` domain: shown in the cmdlet's help example;
    not run. Tenants with several onmicrosoft.com domains are handled by probing each and refusing ambiguity.
41. **Graph `/organization` with the Az PowerShell sign-in** (`Get-AzAccessToken -ResourceTypeName MSGraph`): whether that token
    carries a permission that can read `/organization` for an ordinary admin is NOT confirmed; the step is wrapped so a 401/403 just
    falls through. `/sites/root` (needs a Sites permission) was not used.
42. **What a non-existing `<name>.sharepoint.com` answers** (DNS failure or a generic 404) is unconfirmed: the sandbox proxy blocked
    the test host. Only 200 / 3xx / 401 / 403 are accepted as "tenant exists".
43. **Observed live from the build sandbox (anonymous GET, no redirects followed):** `microsoft.sharepoint.com` 401 in 0.73 s;
    `microsoft-my.sharepoint.com` 302 to `/_layouts/15/authenticate.aspx` in 1.04 s; `microsoft-admin.sharepoint.com` 401 in 0.73 s;
    `oneclient.sfx.ms` 200 in 0.45 s; `admin.onedrive.com` 302 to admin.microsoft.com in 0.41 s. Whether the Power Automate HTTP
    action records the 302 or follows it is still item 4; both classify as alive (no alive list).
44. **Sovereign clouds**: recognised only from the Dataverse host suffix; GCC (crm9.dynamics.com) is treated as commercial
    SharePoint (`.sharepoint.com`), GCC High / DoD / China as unsupported. Not verified against such tenants.
45. **Signed-in synthetic checks** (SharePoint "Send an HTTP request to SharePoint", OneDrive for Business read) were not built:
    operation ids / parameter names in a flow definition could not be confirmed, and the false-failure cases (no OneDrive
    provisioned, conditional access, throttling) could not be distinguished reliably without running them.

46. **Dataverse trigger in a flow definition** (`type: OpenApiConnectionWebhook`, `operationId: SubscribeWebhookTrigger`, parameters
    `subscriptionRequest/message` 1 = added, `subscriptionRequest/entityname`, `subscriptionRequest/scope` 4 = organization): this is the
    shape the designer writes, known from exported flows, **not from reference documentation**. If Dataverse refuses it the deploy
    prints the message, sets `test_button = no`, and alerts stay on (tested with the mock).
47. **Trigger latency**: the trigger page (MicrosoftDocs source of power-automate/dataverse/create-update-delete-trigger) gives no
    time. "Usually within about a minute, can be longer" is the author's expectation, not a documented or measured figure. The
    same page says an update "can result in multiple flow runs"; the flow therefore re-reads the row and acts only on `queued`.
48. **Trigger prerequisites**: that page lists create / read / write / delete on the *Callback Registration* table for the flow
    owner. A System Administrator has them; a less privileged owner was not considered. Licensing of the trigger is not stated on
    the page; the flows need Premium anyway (HTTP action).
49. **Code app write path**: `createRecordAsync` / `retrieveRecordAsync` exist in the typings of `@microsoft/power-apps` (checked in
    `node_modules`), but whether create returns the new row id, and how a 403 is surfaced (`success: false` + message, or a
    rejection), is unconfirmed. Both are handled: id read back by query if missing; any message containing 403 / privilege is
    shown as "NOT ALLOWED", anything else as "could not be requested". `getContext().user.fullName` for the requester name is
    typed as optional; "dashboard user" is used when absent.
50. **Channel facts cited from memory, not fetched** (docs.slack.dev and developer.webex.com were not reachable from the build
    sandbox): Slack incoming webhook answers `200 ok` or 4xx with a short text (`invalid_payload`, `no_service`, ...), rate limit
    about 1 message/second, text must escape `&`, `<`, `>`; Webex incoming webhook accepts `{"text"}` or `{"markdown"}`, message
    limit 7,439 bytes; Teams message size about 28 KB. The caps below are set well under these.
51. **Stale-probe notice**, **delivery-checked state** and **roll-back** (alert-flow audit) exist only in the interpreter runs.

## Channel payloads (alert flow and test-notification flow share `buildPosts`)

| Channel | Transport | Request | Body | Success | Cap (UTF-16 units -> worst-case bytes) | Escaping / injection |
|---|---|---|---|---|---|---|
| Teams | Teams connector, action `PostMessageToConversation`, connection reference `owatch_teams`, poster "Flow bot", location "Channel" | connector call (no URL in the flow) | `body/messageBody` = `<p>text with <br></p>` (HTML) | action status Succeeded | 8,000 after escaping -> at most 24,000 bytes (limit about 28 KB, from memory) | `&`, `<`, `>`, `"` become entities **before** `<br>` is added: no tag, no `<at>` mention, no link markup can come from probe data, the note or the requester name |
| Slack | incoming webhook | `POST` URL (secure inputs/outputs), `Content-Type: application/json`, timeout 20 s, **no retry**, async pattern off | `{"text": "..."}` | HTTP 2xx | 12,000 after escaping -> at most 36,000 bytes (limit 40,000 characters, from memory) | `&`, `<`, `>` escaped: `<!channel>`, `<!here>`, `<@U..>`, `<url|label>` are inert. Plain `@channel` is not a mention in webhook text (from memory). `*bold*` style markup from hostile text may render; it cannot notify anyone |
| Webex | incoming webhook | same | `{"text": "..."}` - the plain `text` field, never `markdown` or `html` | HTTP 2xx | 2,400 -> at most 7,200 bytes (limit 7,439 bytes, from memory) | plain text is not interpreted: no mentions, no links, no markup |
| Generic webhook | any HTTPS endpoint the admin gave | same | `{"text": "..."}` | HTTP 2xx | 12,000 | none applied: the receiver gets plain text and must treat it as such |

All four: one message per round (or per test), newlines `\n`, a message over its cap is cut and ends with
`[message shortened ...]`; a failed post records only the status (`FAILED HTTP 404`, Teams: the error code), never
the response body or the URL. No retry inside a run: the alert flow re-announces undelivered events next round, and
a test simply reports the failure. Rate limits are not a concern at one message per round per channel.

## Test notification flow

Trigger: row added to `owatch_command` (organization scope), concurrency 1 (the rate-limit check cannot race).
Actions: read settings; read the row again; act only if `owatch_name = test_notification` and `owatch_status =
queued`; if `last_test_at` is younger than 300 s write `rejected`; else `sending`, save `last_test_at`, read the
newest complete round and the targets, compose the message (reference: `provision/lib/test-logic.mjs`), one
`If_<channel>` per configured channel (run-after: always, so one failing channel never stops the next), `Finish`
writes `done` / `partial` / `failed` + the per-channel string + `owatch_completedat` (run-after: always, so the
row never stays on `sending` because a query failed); finally delete command rows older than 7 days. Free text
that reaches a channel: the note (200) and the requester name (100), both single-lined, bounded, and escaped by
the same per-channel encoding as probe data. 35 requests per test with four channels, 11 when rejected.

## Test map

| File | Proves |
|---|---|
| `tests/golden.test.ts` + `tests/golden/golden.json` | TS port == real Python (`gen_golden.py` runs `outagewatch.py`) |
| `tests/classify.test.ts`, `tests/graph.test.ts`, `tests/live.test.ts` | flow-specific raw cases, frame replay, STALE rule, blast radius, roles, families, 36-node layout (wide and 360 px), unconfigured/disabled target rows |
| `tests/provision.test.ts` | request sequence, idempotency, resume, upgrade from the 15-target version, tenant name added later, failures, uninstall/purge, CLI exit codes (mock Dataverse over HTTP) |
| `tests/flow.test.ts` | clientdata envelope, run-after, no retries, dumb flow, heartbeat, usage estimate, metadata payloads |
| `tests/validate.test.ts` | GUID (incl. the `.ps1` literal), org-URL allow-list, tenant, heartbeat URL, hostile input |
| `tests/alert-flow.test.ts` + `tests/helpers/wdl.mjs` | reference alert logic; both generated flows EXECUTED by an interpreter against the mock and compared with the reference (lifecycle, channels, incidents, CI status, hostile input, fuzz); structure of the alert flow |
| `tests/upgrade-alerts.test.ts` | upgrade from the deployed version 24090f5 (real old flow definition), channels kept / added / removed, secrets only in the flow definition, alert-flow rejection, CLI exit codes, DryRun |
| `tests/gate.test.ts` | CI gate decisions and end-to-end read from the mock; pipeline snippets and agent definition (structure, existing columns) |
| `tests/insights.test.ts` | every insight rule with its evidence, boundaries, hostile and degenerate input, deterministic report |
| `tests/tenant.test.ts` | SharePoint tenant name: extraction, validation, reachability probe (local server), CLI, upgrade from bcadc4c incl. admin edits |
| `tests/test-notification.test.ts`, `tests/notify.test.ts` | test-notification flow EXECUTED and compared with its reference (status, per-channel result, message per channel), channel-failure combinations, duplicate trigger, rate limit, hostile note, pruning, 403, CLI exit codes; dashboard helpers (availability, result parsing, demo notifier) |
| `tests/limits.test.ts` | every value the provisioner or the flow can write fits its column; mock enforces limits (0x80044331); re-run on top of the failed third real run |
| `tests/ps1-static.test.ts` | `.ps1` balanced, PS 5.1-compatible syntax, ASCII, no secrets printed, `.cmd` wrappers |

## Found on the first real run (not from documentation)
- Adding the first column to a just-created table returned `HTTP 400 An unexpected error occurred.` (likely a transient metadata collision;
  the payload follows the documented IntegerAttributeMetadata shape). Added wait-for-table + checked retry. UNCONFIRMED whether this is the real cause:
  if it persists, the request id printed by the script is the next diagnostic.
- Second real run: `GET owatch_settings` failed with 0x80060888 'Could not find a property named owatch_value' although the column creation had succeeded
  (the Web API schema cache lags behind metadata changes). Added wait-for-columns before seeding and a retry on that exact error. UNCONFIRMED against a real tenant.
- Third real run: steps 1-6 passed, so **flow creation through `POST workflows` with the hand-written `clientdata` was accepted** by a real
  environment (item 3 is confirmed for creation only, not for running). Step 7 failed with 0x80044331: the seeded `roles_json` setting was 618
  characters, the `owatch_value` column holds 400. This was a plain bug that no test caught, because the only length test covered target rows and
  the mock did not enforce column limits. Fix: the role list is not stored any more (built into the dashboard; optional override rows
  `roles_json`, `roles_json_2`, ...). Chosen over widening the column or adding a Memo column because it changes nothing on tables that already
  exist: no metadata call, no publish, no schema-cache wait, nothing to migrate. Class fix: `columnSpec()` derives limits from the same payloads
  that create the columns; `assertRowFits()` checks every row before it is sent; the flow bounds runtime values (`take(string(..),N)`, clamped
  elapsed time, fixed-width round id); the mock rejects oversize values with the real error code; `tests/limits.test.ts` covers all of it,
  including a re-run on top of exactly the state the failed run left behind. UNCONFIRMED against a real tenant.
- Everything after step 7 (turning the flow on, a flow RUN, code app push, smoke test) has still never run for real: expect further first-run findings there.
