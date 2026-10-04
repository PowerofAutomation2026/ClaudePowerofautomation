# Ownership Command Center

A Power Apps **code app** (React + TypeScript) for Power Platform admins:
enter a user's email → see every canvas/model app and cloud flow they own **across all environments** →
transfer ownership of selected items, or everything, to a new owner.

**No Azure app registration.** It runs on the signed-in admin's own connector connections:
Power Apps for Admins, Power Platform for Admins, Power Automate Management (+ optional Power Automate for Admins), Office 365 Users.

## Deploy (zero touch)

```powershell
./scripts/Deploy-OwnershipCommandCenter.ps1                 # prompts for environment ID
./scripts/Deploy-OwnershipCommandCenter.ps1 -EnvironmentId <guid>
```
It installs Node/`pac` if missing, signs you in, wires the three connectors (opens the Connections page if one is missing), builds and runs `pac code push`.

Requirements: Power Apps premium licence for the admin users (code apps + premium connectors) and code apps enabled on the target environment.

## Features
- Email → user → inventory across all (or one) environment, with scan progress and recent-user chips
- Stats dashboard, per-environment bars (click to filter), search / type / state filters, sorting
- Select individual rows, all visible, all apps, all flows, or stale items (>6 months) — or transfer everything
- **Replace owner** or **add as co-owner** (flows), optionally remove previous owner
- **Dry run** (default on), typed confirmation for big batches, per-item status, **retry failed**, **undo last batch**
- Risk flags: solution-aware items, flows with connections tied to the old owner, stopped/suspended flows
- **Generate the equivalent PowerShell** for change tickets
- Audit history (CSV export), inventory export (CSV/JSON)
- Dark/light theme, Ctrl+K command palette, `/` to focus search, Demo mode with a sample tenant

## Develop
```bash
npm install
npm run dev      # Demo mode in the browser
npm run build
```

## Fallback without the UI (still no app registration)
In the transfer panel click **⬇ Plan CSV** (put the new owner's *object id* in `NewOwnerId`), then run
`./scripts/Invoke-OwnershipPlan.ps1 -PlanCsv plan.csv -WhatIf` and again without `-WhatIf`. It uses Microsoft's own admin
module with interactive sign-in.

## Important: verify the connector bindings
The app calls connectors through the code-apps SDK (`getClient().executeAsync`) using the operations in the generated
`.power/schemas/appschemas/dataSourcesInfo.ts`. `src/services/live.ts` finds each operation by its REST path and verb
(e.g. `POST …/modifyAppOwner`), so generated method names don't matter. After deploying, open **🩺 Diagnostics**:
every operation should say *bound*. If one is missing, adjust its path pattern in `OPS`. This could not be tested
against a live tenant while building, so treat the first Live run as a pilot: use **Dry run**, then try one item.

Notes: Power Apps have a single owner (co-owner mode applies to flows only). Solution flows may need their
connection references re-pointed after transfer.

## Connectors needed (create each once in the target environment)
| Connector | Id | Used for |
|---|---|---|
| Power Apps for Admins | `shared_powerappsforadmins` | list apps, change app owner |
| Power Platform for Admins | `shared_powerplatformforadmins` | list all environments |
| Power Automate Management | `shared_flowmanagement` | list flows, change flow owner as admin |
| Office 365 Users | `shared_office365users` | email → user object id |
| Power Automate for Admins *(optional)* | `shared_microsoftflowforadmins` | flow list with creator, flow owner lookups |
| Power Platform for Admins V2 | `shared_powerplatformadminv2` | **Copilot Studio agents**: tenant-wide inventory query + *Reassign the owner of the bot* |

## Troubleshooting
* **"Connector operation … not found"** → open 🩺 Diagnostics, click *Copy diagnostics*; each connector's real operations are listed.
  Re-run the deploy script to add the missing connector, then redeploy.
* Re-running the script on an existing folder reuses `power.config.json` (same app, updated in place). Extract new versions *over* the old folder.
* **Build fails inside `src/generated/...` (e.g. `api-version?: string`)** → a `pac` code-generation bug; the app doesn't use `src/generated`
  (it reads `.power/schemas/appschemas/dataSourcesInfo.ts`). `tsconfig.json` excludes that folder and the deploy script falls back to a plain `vite build`.
* **`ApplicationDisplayNameIsInUse` on publish** → `power.config.json` was lost/recreated. The deploy script now binds to the existing app automatically
  (sets `appId` in `power.config.json`) and updates it in place. Keep `power.config.json` between runs.
* **`power.config.json is required to push an app`** → the file was missing/unreadable (a UTF-8 BOM from Windows PowerShell breaks `pac`). The deploy script
  now edits it without a BOM, keeps a copy in `.deploy-state/`, restores it if `pac` removes it, and as a last resort publishes under a new dated name.
* **`InvalidApiVersion`** → the connectors list `api-version` as optional but the service requires it. The app always sends it and, if rejected, reads the accepted versions from the error and retries.

## Copilot Studio agents (experimental)
**This app's own environment** is read through the app's built-in Dataverse access: the deploy script runs `pac code add-data-source -a dataverse -t bot` and `-t systemuser`
(no extra connection). **Other environments** need the optional *Microsoft Dataverse (legacy)* connector.
Agents are Dataverse `bot` rows. With the optional *Microsoft Dataverse (legacy)* connector the app finds the user's Dataverse record in each
environment that has a database, lists `bots` owned by them and transfers ownership with `ownerid@odata.bind`. The new owner must already be a user in
that environment. Agents have a single owner. Verify with a dry run, then one agent, first.

## Scan report
After every scan the *Scan report* card lists, per environment, how many apps / flows / agents were listed and how many belong to the user, plus any
warnings (for example "not an admin in this environment"). Use *Copy* to share it when something looks missing.

* **Browser tab crashes with "Out of Memory"** → fixed in v1.3.0: one SDK client for the whole session, environments scanned one at a time, owner lookups
  capped (400 flows/environment) and limited to 4 at once. If it still happens, scan one environment at a time (pick it in the dropdown) and close other tabs.

* **Crash breadcrumb** → if a tab dies, the next load shows "Last time this page stopped unexpectedly while …" naming the environment/phase it was scanning.
* Large environments are read page by page (max 10 pages / 20,000 items per list) and the report tells you if a list was cut off.
* **Agents show 0 although the Dataverse tables were added** → `pac` names the data sources by display name (`agents`, `users`); v1.4.1 identifies them by primary key / entity set instead. 🩺 shows which data source each table mapped to.
* **Transfer "does nothing"** → the new owner's email must be entered first. v1.5.0 explains this inline, accepts Enter, and shows the result (dry-run or real) in the drawer.
* **Agents in other environments** → agents are read from the environment the app is deployed in. Run the deploy script again with that environment's ID (state is kept per environment in `.deploy-state/<envId>`).

## Copilot Studio agents (v1.6.0 – tenant-wide)
Discovery uses the **Power Platform inventory** (action *Query Power Platform resources*, type `microsoft.copilotstudio/agents`, property `ownerId`) so agents in **every environment**
show up from one deployment. Transfer uses *Reassign the owner of the bot* (`ReassignCopilotAgent`, body `NewOwnerAadUserId`).
Requirements: the connection's account must be a tenant/Power Platform admin and hold **System Administrator** in the agent's environment; the new owner needs the
**System Customizer** role there (temporarily) and a Microsoft 365 Copilot licence. Classic chatbots are not supported by the reassign API (HTTP 405).
If discovery shows 0, open the Scan report: it prints the owner ids it saw so the id format can be compared.

## v1.7.0 – only real Copilot Studio agents + new look
* The tenant inventory type `microsoft.copilotstudio/agents` also contains Agent Builder agents, CLI-harness agents and tool / MCP style entries. Every item is
  classified (`agent`, `agentbuilder`, `tool`, `mcp`, `cli`, `other`) from its inventory properties. **Only `agent` is shown and transferable by default**; the rest are
  counted in a banner ("N other inventory items are hidden") with a *Show them* toggle. The Scan report prints the classification counts and the property values it saw,
  so the rules can be tuned from real data.
* New interface: animated aurora background, profile hero with type-mix bar (blue = apps, orange = flows, aqua = agents – validated colour slots 1-3 with direct labels),
  icon stat tiles with count-up, tabs with counts, type chips, status dots, shimmer skeleton while scanning. Dark and light themes.

## v1.7.1 – agent transfer failures
* A failed transfer no longer clears the item list: the error stays on screen (full service text, HTTP status) with a plain-language "Why this usually fails" box and **Retry**.
* Agent transfer first calls *Reassign the owner of the bot*; if that fails and the agent lives in the app's own environment it falls back to a Dataverse assign.
* Known causes (Microsoft docs / community): the **new owner needs the System Customizer role** in the agent's environment (temporarily) and a Microsoft 365 Copilot licence;
  the connection account needs System Administrator there; **managed-solution** agents can be blocked (make an unmanaged edit or use the admin center *Change owner*);
  **classic chatbots** return HTTP 405.

## v1.7.2 – "HTTP 502 … only partially updated" when transferring an agent
That is the Copilot Studio reassign API refusing to finish. Documented cause: the **new owner lacks the System Customizer security role in the agent's environment**
(or isn't a user there / has no licence). The connector only shows a generic *"The response is not in a JSON format"*; the real reason is in `innerError`, which the app now shows.
1. Admin center → Environments → *(agent's environment)* → Users → new owner → Manage security roles → tick **System Customizer** → Save (wait 1-2 min).
2. Click **Retry** in the transfer panel. If a failed attempt left the agent half-updated, **↩ Restore original owner** puts it back.

## v1.7.3 – transferring an agent WITHOUT System Customizer
Microsoft's documented requirements for the new owner of a reassigned agent are only: a **Copilot Studio / Microsoft 365 Copilot licence** and **membership of the agent's environment**; the service
then grants *Environment Maker* itself. (System Customizer appears only in a community fix, most likely because adding any role creates the environment user record.)
* Add the new owner as a **member** of the environment first (admin center → Environments → *env* → Users → Add user, lowest role), wait 1-2 min, transfer.
* The app now asks you to confirm the checklist before a real agent transfer, and for agents in the app's own environment it **checks the new owner's user record first** and stops *before* calling the service (no half-updated agents).
* Only if it still fails: temporarily add System Customizer, retry, remove.

## v1.7.4 – built-in "add new owner to the environment" step (no roles)
Before a real agent transfer the app calls the Power Platform for Admins operation **Add Admin Power Apps Sync User** for each agent environment, which makes the new owner a
member (Dataverse user record) of that environment without assigning any security role – Microsoft's documented requirement for a reassign. Untick it in the panel to skip. If it fails
(for example the connection account lacks rights) the error is shown and the transfer still proceeds. Wait ~1 min and Retry if the reassign reports "partially updated".

## v1.7.5 – recovering agents left half-updated
* **History → "↩ Restore to <original owner>"** appears on every failed agent transfer and works after a page reload (the audit log is kept in the browser).
* Re-running a reassignment for the **same owner** is allowed for agents (repair mode): scan the new owner, select the agent, enter the same email, transfer.
* Failure tips now include the discriminating test (same agent → a different fully licensed user) and verification (open the agent in Copilot Studio as its owner).

## v1.7.6
Agent reassign retries once automatically (after 8 s) when the service answers HTTP 502 / "partially updated" – Microsoft's own error text says another reassignment is the repair.
Advisor findings (see chat): the most likely cause is the **new owner has no Copilot Studio licence / no enabled environment user**; check licence and sign-in first, or reassign to a healthy licensed admin.

## v1.8.0 – safe agent transfer protocol (no more corrupted agents from a batch)
Found by code review + an independent advisor review + a simulated Copilot Studio service (9 scenarios, `src/transferPlan.ts`):
* **Pilot / stop-on-first-failure:** agents are reassigned strictly one at a time; the first service failure STOPS the batch (remaining agents are `skipped`, untouched). Before, 3 parallel workers kept going and one click could half-update every selected agent.
* **Membership gate:** the new owner is added to each environment (Add Admin Power Apps Sync User) and, where checkable, confirmed; any failure blocks that environment's agents ("Not attempted – nothing was changed"). "user does not exist" is no longer mistaken for "already a member".
* **No automatic retry, no Dataverse fallback after a failed reassign** (both could worsen/hide a half-updated agent). Retry is manual, after fixing the cause.
* **Only real Copilot Studio agents** can be sent to the reassign API; tool / MCP / Agent Builder / CLI rows are refused. Classification no longer looks at display names.
* **Verification:** after a successful reassign the inventory is queried; the result is shown per agent (inventory may lag 5–15 min).
* **Restore / Undo** are audited, appear only for genuine "partially updated" failures, stop at the first failure, and use the options of the original batch.
Residual risk: the app cannot read licences. An unlicensed new owner can still half-update the *first* (pilot) agent – check the licence first; use History → Restore if it happens.

## v1.9.0 – "moved" now means CONFIRMED at the source
Audit result: every transfer is a real server-side admin API call (agents: `ReassignCopilotAgent`; apps: `Set-AdminAppOwner`; flows: `modifyPermissions` Owner role). The UI never changes ownership by itself.
But "success" used to mean only "the service answered 2xx". Now, after each transfer the owner is **read back from the source** (agents: Dataverse `bot.ownerid` in the app's own environment, otherwise the tenant inventory, re-read after 12 s;
apps: Get Admin App; flows: owner roles) and each row shows **Verified at the source** or **⚠ NOT confirmed**. Only confirmed rows leave the table; unconfirmed rows stay with a **🔄 Re-check at the source** button.
* Flows keep an immutable *creator*; a rescan now also checks the Owner role, so a transferred flow is no longer listed under the old owner.
* Membership settle time before an agent reassign raised from 4 s to 8 s.
* Where to look as the new owner: Copilot Studio → pick the SAME environment as the agent (e.g. *microsoft (default)*) → Agents. Admin center / inventory can lag 5–15 min.

## v1.9.1 – live agent count (deleted agents no longer listed)
The tenant inventory keeps showing deleted agents for a while. After the inventory read, every agent is now checked against the Dataverse `bot` table of its own environment: deleted agents and agents whose owner already changed are dropped, name/state are refreshed. The Scan report says how many were confirmed, how many deleted ones were removed, and how many could not be live-checked (environments this app cannot reach).

## v1.9.2 – accurate live agents, real operation log, auto-refresh
- **CLI / GitHub-Copilot-powered agents** (e.g. `copilotowner26`, `TESTOWNERTRANSFER`) are real Copilot Studio agents and are now listed (tagged "GitHub Copilot") instead of hidden.
- **Live check**: agents are confirmed against Dataverse; rows show `✓ live` or `⚠ not live-checked`. The inventory can still list DELETED agents, so for the exact count deploy the app into the agents' environment (e.g. `-EnvironmentId Default-<tenantId>`) or add the optional Microsoft Dataverse connector (the deploy script now offers it).
- **Agent pre-flight**: before reassigning, the agent must still exist in Dataverse, otherwise nothing is sent.
- **Operation log** (Transfer drawer and Diagnostics): every connector call, pre-flight, transfer, read-back result with timestamps; Copy log button.
- **Auto-refresh**: 5 s after a real transfer the user is re-scanned so the table shows live data.

## v1.9.4 – a failed agent transfer never takes the agent from the original user
- When the reassign fails half-way (HTTP 502 "partially updated") the app first READS the owner at the source: if the new owner is already confirmed it says so; if the original owner is still confirmed it says "nothing changed"; only otherwise it reassigns back to the original owner automatically (one attempt) and reads back again. The batch still stops at the first failure.
- New pre-flight: a disabled or non-interactive target user in the agent's environment blocks the transfer before anything is sent (environment this app runs in).
- If it still fails with the target a licensed environment member, the usual cause is the target's Copilot Studio licence/service plan - test by signing in as that user in Copilot Studio.

## v1.9.5 – licence-first guidance for the agent 502
Microsoft: agent ownership can only be reassigned to a user with an ACTIVE Microsoft 365 Copilot licence. If a transfer returns 502 "partially updated" while the target is an environment member and the app shows "Nothing changed … still the owner (CONFIRMED)", assign the licence to the target in the Microsoft 365 admin center, wait ~10 minutes, and retry. The pre-flight now says honestly when the target's user status could not be checked.

## v1.9.6 – live agents from Dataverse (any environment), no more false "nothing changed"
- The tenant inventory lags BOTH ways (transferred/deleted agents linger, new agents missing). Agents are now reconciled against Dataverse of each environment: this app's own environment natively, every other environment through the Microsoft Dataverse connector (added by the deploy script). Agents that exist in Dataverse but not yet in the inventory are added; deleted / already-moved ones are removed. Rows show `✓ live`.
- Read-backs (after a transfer) use the same Dataverse source. An inventory mismatch is never treated as proof of "nothing changed", and the automatic rollback only runs when Dataverse itself shows the agent is neither with the new nor the original owner.
- New: `↗ open` link on every row (opens the item in its own portal to check the Owner column) and `⬇ Download receipt` (the full operation log as a text file).
- Observed in a real tenant: a 502 "partially updated" can still end with the agent owned by the new user - always check the Owner column in Copilot Studio.

## v1.9.7 – transfer a whole solution
`📦 Solutions` (also Ctrl K → "Transfer a whole solution") lists the solutions that contain the scanned user's apps, cloud flows and Copilot Studio agents (read through the Microsoft Dataverse connector). Pick one to select all of that user's items in it, then transfer them with the normal verified pipeline (dry run, read-back, rollback protection).
Limits (by design): a solution itself has no owner; tables, security roles, plug-ins, model-driven apps are organisation-owned; classic workflows / connection references / environment variable values are not moved by this app; flows keep the OLD owner's connections until the new owner re-binds them; managed solutions may block some changes.

## v1.9.8 – Report studio (CSV + PDF)
`📄 Report` (or Ctrl K → "Report") opens a report for the scanned user: choose apps / flows / agents (or only the selected items), preview, then download a CSV (UTF-8 with BOM, opens in Excel) or a PDF (built in the browser, no libraries). Columns: type, name, id, created time, environment name, environment id, owner, state.

## v1.9.9 – new agents appear immediately, multi-user PDF report, agent 502 polling
- **Live source**: 🩺 Diagnostics now has a real "Live Dataverse test" per environment (✔ = agents are read live there, so a brand-new agent shows up on the next scan). If the live source is unavailable for some environments the main screen shows an amber banner with "↻ Re-scan now" instead of silently listing a stale inventory.
- **Agent transfer**: when the service answers 502 "partially updated", the app now polls the REAL owner for ~50 s (Copilot Studio often finishes the change after answering with an error) before deciding; only then does the read-before-rollback logic run.
- **Report studio**: add more users (emails, comma/space/new line); each is scanned across all environments; one CSV (all rows, Owner column) and one PDF with a section per user. Filter apps / flows / agents with the three count buttons.

## v1.9.10 – make the live Dataverse source reachable for other environments
- The environment list often omits each environment's Dataverse address, which silently disabled the live agent check outside the app's own environment. Missing addresses are now read per environment (and `$expand=properties.linkedEnvironmentMetadata` is requested when supported).
- The Dataverse connector is called with the organisation as `host` and, if that fails, as `https://host` (the working form is remembered).
- Transfer drawer: every item has a link to check its Owner in its own portal.
- **Most reliable setup**: deploy the app INTO the environment that holds the agents (`-EnvironmentId e6c360d6-57a5-473e-9188-3bfac0e3250e` for "microsoft (default)"). There the app reads and verifies agents natively, with no connector guesswork.

## v1.9.11 – Dataverse connector call matches Microsoft's own parameters
Cross-environment reads use `ListRecordsWithOrganization` with `organization = https://orgXXXX.crm.dynamics.com`, `entityName`, `$filter/$select/$top` and `accept` (found in public code-app samples). Parameters are matched by meaning, wherever the connector places them; the plain hostname is tried as a fallback.
