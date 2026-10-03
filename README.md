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
| Power Automate for Admins *(optional)* | `shared_microsoftflowforadmins` | extra flow admin operations |

## Troubleshooting
* **"Connector operation … not found"** → open 🩺 Diagnostics, click *Copy diagnostics*; each connector's real operations are listed.
  Re-run the deploy script to add the missing connector, then redeploy.
* Re-running the script on an existing folder reuses `power.config.json` (same app, updated in place). Extract new versions *over* the old folder.
