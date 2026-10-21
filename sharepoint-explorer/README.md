# PNC SharePoint Team — Explorer (Power Apps code app)

Connect **any SharePoint list or document library** with one button and get a grid, an auto-built dashboard,
instant search and PDF / CSV / JSON export. Built for lists with **millions of rows**: the browser never holds more than a
capped window of rows; everything else is paged, streamed or aggregated.

## Deploy (zero touch)

```powershell
./scripts/Deploy-SharePointExplorer.ps1                       # prompts for environment + config site
./scripts/Deploy-SharePointExplorer.ps1 -EnvironmentId <guid> -ConfigSiteUrl https://contoso.sharepoint.com/sites/Apps
# or just double-click Deploy.cmd
```
It installs Node / `pac` if missing, signs you in, picks the environment, registers the SharePoint connector, **bakes the app
owner into the bundle** (you, or `-OwnerUpn a@x.com,b@x.com`), builds and runs `pac code push`.
The one thing that cannot be scripted is the one-time OAuth sign-in that creates the SharePoint *connection*; if it is missing
the script opens the right page and waits.

Then: open the app → **Connect** tab → site → list/library → **Connect**. Every user now opens the same data.
Share the app with users in make.powerapps.com (code apps need a Power Apps premium licence).

## Who can connect what
* Only **owners** (listed in `src/appconfig.json`, written by the deploy script) see the Connect screen. Everybody else sees a read-only “Source” page.
* The choice is saved in a small list `SPX_Config` on the config site (created by the owner on first Connect) so all users get it.
* **Limits of this, stated plainly:** the gate is enforced in the app UI, and owners come from the compiled bundle. A determined
  user with edit rights on the `SPX_Config` list could still change the saved choice, so give users *Read* and owners *Edit* on that list.
  Real data security is always SharePoint permissions: each user only sees what their own connection may see.

## Roles: read-only / contributor / data admin
Roles come from the **SharePoint permissions on the connected list** (read live via `EffectiveBasePermissions` + your groups), so SharePoint
enforces them and the app only mirrors them. If SharePoint cannot answer, the app falls back to read-only.

| Role | Who | Can do |
|---|---|---|
| **Read-only** | any Microsoft 365 user with *Read* | search, filter, dashboards, views, export |
| **Contributor** | members of a SharePoint group with *Contribute/Edit* | + add items, edit items |
| **Data admin** | *Full Control / Manage Lists* (or named admin groups) | + delete (to the recycle bin), bulk delete, shared views for groups |
| **App owner** | listed at deploy time | connect/disconnect lists, name optional writer/admin groups. Owners manage the *app*; data admins manage the *data*. |

Owners can additionally name **writer groups / admin groups** (Connect → Who can do what). These can only *restrict* what SharePoint allows.
A role badge in the header shows your level (hover for the reason). Libraries: metadata edit and delete only (no file upload).

## Views
Save the current search, filters, sort, columns and layout as a view: **only me**, **everyone**, **specific SharePoint groups**, or **data admins only**.
Personal views are stored per user; shared views in the `SPX_Config` list (data admins therefore need Edit on that list).
A view changes what is *shown*; it is not a security boundary: SharePoint permissions are.

## Search for millions of rows
* Up to 25k items: instant in-memory search with relevance ranking (title hits first) and highlighting.
* Larger lists: free-text uses the **SharePoint Search index** (ranked, no table scan, any size) and falls back to a filter query if nothing is indexed yet.
* Syntax everywhere: `word1 word2`, `"exact phrase"`, `-exclude`, `Status:open` (column-scoped, becomes a server filter).
* Typeahead suggestions (memory or cancellable server query) and recent searches; debounced and cancellable so typing never blocks.

## Features
| | |
|---|---|
| **Connect** | any site → lists & libraries with item counts → pick → Connect. Several sources can be published; users switch from the header. |
| **Dynamic UI** | columns, types, filters, pills, avatars, file icons, dashboard widgets and insights are generated from the list/library schema. Libraries additionally get file types, storage, largest files and a folders toggle. |
| **Auto dashboard** | KPIs, activity timeline, per-column breakdowns (click a bar → filters the grid), data health (fill rate), numeric summary, plain-language insights, “Dashboard PDF”. |
| **Search & filter** | ≤ 25k items: instant, all-column, multi-word search in memory with highlighting. Larger: server-side. Quick filters, date presets, advanced filter builder, saved views. |
| **Export** | CSV (spreadsheet-formula-safe), JSON, PDF; selected rows / loaded rows / *everything matching* streamed page by page straight to disk. |
| **Live pulse** *(extra 1)* | polls for new and changed items, toasts, highlights new rows, live feed. |
| **Smart insights + deep scan** *(extra 2)* | auto-written findings (growth vs. last week, stale items, duplicates, dominant values, sparsely filled columns) and a cancellable **deep scan** that aggregates the whole list while you keep working. |
| **More** | card/table views, resizable & hideable columns, item drawer with previous/next, command palette (Ctrl+K), “Index column” helper for owners. |
| **Accessibility** | light / dark / **high-contrast** / system themes, text-size control, keyboard-operable grid (↑↓ PgUp/PgDn Home/End, Enter, Space), ARIA grid/dialog/live regions, focus trap, skip link, reduced-motion, charts with text equivalents. axe-core reported 0 violations on the dashboard in all three themes. |

## Heavy-duty design (millions of rows, no freeze)
* **Virtualised grid** – only visible rows exist in the DOM (≈30 rows regardless of list size).
* **Keyset paging on `ID`** (never `$skip`) with `$top` ≤ 5,000, which avoids SharePoint’s 5,000-item list-view threshold; page size adapts while scrolling fast; in-memory cap of 150k rows with a clear message; a “Jump” slider seeks by ID range.
* **Server-side search/filter**, stale requests are cancelled; connector calls are throttled (4 in parallel) with exponential back-off on 429/503.
* **Streaming aggregation** for the dashboard: only counters are kept, work is chunked and yields to the UI.
* Streaming exports (File System Access API when available, chunked Blob fallback). PDF is capped at 5,000 rows by design.
* On very large lists SharePoint can only filter/sort on **indexed** columns. Owners get an **Index column** helper (Connect → Performance). Without an index SharePoint returns a threshold error, which the app explains.

## Develop
```bash
npm install
npm run dev      # starts with a built-in demo tenant (2,000,000-row list, 180k library, …); ?demo=1 forces it
npm run build
```
Outside Power Apps (or without the SharePoint connector) the app automatically uses the demo backend.

## How it talks to SharePoint
Through the code-apps SDK and the user's own SharePoint connection, using the connector's *Send an HTTP request to SharePoint*
action (plain SharePoint REST) with the site URL as the `dataset`, so one registered connector reaches any site or list. At start-up the app
adds that operation to the generated data-source description (`src/services/sp.ts`), because `pac` only describes one list for tabular connectors.

> **Status:** developed and tested against the demo backend and against an in-memory emulation of the SharePoint REST endpoints
> (the deploy script was run against a stubbed `pac`). It has **not** been run against a real tenant. Treat the first deployment as a pilot:
> connect a small list first, then a big one. If connector registration is rejected, run the command the script prints:
> `pac code add-data-source -a shared_sharepointonline -c <connectionId> -d <site> -t <existing list>`.
