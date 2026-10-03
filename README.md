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
