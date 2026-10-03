# Ownership Command Center

A Power Apps **code app** (React + TypeScript) for Power Platform admins:
enter a user's email → see every canvas/model app and cloud flow they own **across all environments** →
transfer ownership of selected items, or everything, to a new owner.

**No Azure app registration.** It runs on the signed-in admin's own connector connections:
Power Apps for Admins, Power Automate for Admins, Office 365 Users.

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

## Important: verify the connector bindings
`pac code add-data-source` generates connector services into `src/generated/services`. Method names and
argument order depend on the connector version, so `src/services/live.ts` binds each operation by name pattern
(`OPS`). After deploying, open **🩺 Diagnostics** in the app: every operation should say *bound*. If one says
*missing*, adjust the pattern (or argument shape) in `OPS` for your generated service. This could not be tested
against a live tenant while building, so treat the first Live run as a pilot: use **Dry run**, then try one item.

Notes: Power Apps have a single owner (co-owner mode applies to flows only). Solution flows may need their
connection references re-pointed after transfer.
