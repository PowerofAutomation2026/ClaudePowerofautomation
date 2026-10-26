# PNC SharePoint Team — Explorer (Power Apps code app)

Connect **any SharePoint list or document library** with one button and get a grid, an auto-built dashboard,
instant search and PDF / CSV / JSON export. Built for lists with **millions of rows**: the browser never holds more than a
capped window of rows; everything else is paged, streamed or aggregated.

## AI assistant: Copilot Studio and Microsoft 365 Copilot agents

Admins open **Assistant → Setup** (the Assistant button in the header) and add agents; everyone then sees them for the lists/libraries in scope.
- **Copilot Studio agent (chat inside the app):** uses the *Microsoft Copilot Studio* connector (`ExecuteCopilotAsyncV2`), so it needs no extra app registration or CSP changes and runs with each user's own connection. Enter the agent's **schema name** (Copilot Studio → Settings → Advanced → Metadata, case-sensitive) and press **Test connection**. The agent must be **published**, shared with your users, and a *classic* (Standard) agent — agents built in the new agentic experience can't be called through the connector yet.
- **Agent Builder / Microsoft 365 Copilot / Copilot Lite agent (link):** these agents can't be called from an app by Microsoft's design, so paste the agent's **Share link**; the app opens it and can **copy a prompt with context** (what list you're in, filters, selected items) to paste into the chat.
- **Context:** every question can carry a `[CONTEXT]{…}[/CONTEXT]` block (source, search/filters, selected items with key columns and approval status). Setup gives you ready-to-paste **agent instructions** and the **knowledge-source URL** of the current list/library so the agent answers from the same data.
- Chat UX: suggested prompts (yours + built-ins), selection-aware shortcuts, typing indicator, copy answer, New chat, multi-turn (conversation id, with a short-history fallback), safe markdown (bold, lists, links).
- To enable in-app chat the connector must be attached: `Deploy.cmd` now asks "Add AI assistant support?" (or run `Deploy.cmd -AddCopilotStudio`; `-NoCopilotStudio` skips the question), or run `pac code add-data-source -a shared_microsoftcopilotstudio -c <connection id>` and republish. Users need the licences Power Apps code apps and Copilot Studio require; Copilot Studio message capacity applies.

## Approvals (lists and libraries, multi-layer)

Admins (data admins / app owners) open **Approvals → Design workflow** and build the process for that list or library:
- Any number of **approval layers (steps)**, reorderable; each has a name, its own **approvers** (people or SharePoint groups, searched from the directory), a rule (**any one** approver or **everyone** must approve) and optional **due days**.
- Options: comment required to reject, whether submitters may approve their own request, and who may submit (editors / everyone / admins). The workflow can be turned off at any time; running requests keep a snapshot of their steps.
- Users select files/items and press **Submit for approval** (or use the row menu → *Approval…*). Each approver sees **Approvals → Waiting for me** and can **Approve**, **Reject** or **Request changes** with a comment; the request moves to the next layer automatically. Rejected / changes-requested items can be **resubmitted**.
- Every file/item shows an **approval tag** in the grid (Pending 1/2, Approved, Rejected…), and the details panel has an **Approval** tab with the step tracker, who is being waited on, due dates and the complete **history** (who, what, when, comment). Admins also get *Everything* with status filters.
- **Notify approvers / submitter** opens a prefilled Outlook-on-the-web message.
- Requests and history are stored in the `SPX_Config` list, so everyone who approves needs to be able to add/edit items there (the same list that already stores personal views). Approvals do not change SharePoint's own permissions or Content Approval setting.

### Automatic approvals, conditions and more (v1.8)

In the workflow designer, **When does approval start? → Automatically**:
- Start approval **when a new file/item is created** and/or **when it is modified**, only when **ALL/ANY** of your **criteria** match (e.g. *Department is Legal*, *Amount ≥ 5000*). For modifications you can choose **watched columns** (re-approve only when those change) and whether an edit while still waiting **restarts** the approval. A **Pause** switch stops automatic submissions without touching anything else.
- Items created/changed before you save are never submitted, so enabling it does not flood old data. Files still being saved/checked in (changed in the last 90 s) wait for the next check; one check submits at most 25 items.
- The check runs while **anyone has the app open** (after each save and about every 45 s) and works for changes made in SharePoint too. It cannot run when nobody has the app open — for guaranteed always-on triggering pair it with a Power Automate flow.
- **Conditional layers:** any step can be limited with conditions (e.g. a CFO layer only when *Amount ≥ 10000*); if no layer applies the item is recorded as automatically approved.
- **Escalation:** a step with *Due in N days* can add escalation approvers when it becomes overdue.
- **Delegate…** hands your part of a step to someone else; **bulk Approve / Reject** from *Waiting for me*; **Export history (CSV)** audit trail; an **Approvals** dashboard widget (pending / overdue / approved / average days). Two people acting on the same request at once are detected and the second is asked to refresh.

## Email files and folders (libraries)

Select files/folders (or row menu → **Email…**) and press **Email**. They go in as links (optionally "people in my organization can view" sharing links). Then:
- **Open in Outlook (web)** – a prefilled compose window.
- **Default mail app** – `mailto:`; **Copy message** – rich text on the clipboard (always works); **Download .eml** – a draft file, with files from your computer attached (classic Outlook opens it as an editable draft; downloads can be blocked inside Power Apps).
SharePoint's old built-in mail API was retired by Microsoft in 2025, so the app no longer sends mail itself — nothing is sent until you press Send in your mail client.

## Customizable live dashboard (admins)

Until an admin designs one, everyone sees the auto-built dashboard. Data admins and app owners get a **Customize dashboard** button:

- **Widgets:** Number (count / sum / average / smallest / largest of any column), Goal gauge, Bar chart, Donut chart, Timeline (day / week / month / year), Top-N list, and Note.
- Each widget can have its own title, width, grouping column and an optional **"only count items where…"** filter; click a KPI or chart slice to jump to the matching items.
- Add, edit, remove and reorder widgets, set the auto-refresh (30 s / 1 min / 5 min) and press **Save for everyone**. The layout is stored per list in the `SPX_Config` list, so everybody sees the admin's dashboard, always computed from live data and each person's own SharePoint permissions.
- **Reset to auto** returns everyone to the auto-built dashboard. Regular users never see the editor.
- On huge lists the widgets use the latest 3,000 items (exact total shown for unfiltered counts); **Scan everything** streams every item without freezing the app.

## Inline editing and colour rules
* **Edit right in the grid (Excel-style)**: double-click a cell, or move with the arrow keys and press **Enter / F2**. **Enter** saves and moves down, **Tab / Shift+Tab** saves and moves sideways, **Esc** cancels, **Ctrl+Z** undoes the last edit (20 steps). Text, numbers, currency, dates, Yes/No and choice columns edit inline; notes, people, multi-choice and links open the full form. Contributors/admins only; every edit is checked against SharePoint permissions and rolled back with a message if refused. The title column still opens details on click; **Shift+Enter** always opens details.
* **Colour rules (conditional formatting)**: *Format* → add rules like *Status is Blocked → red ⚑* or *Due date before today → orange*. Row or cell scope, bold/strike-through, ordered priority, relative dates (`today`, `today-7`, `today+30`), a legend with counts (click to filter). Saved **just for you** or, for data admins/owners, **for everyone** on the list. Applied in table, board and calendar; colour is always paired with a marker for accessibility.
* Both features were picked by the Fable 5.1 advisor from community demand (editable grids and conditional formatting are among the most requested things for SharePoint list apps).

## Troubleshooting
* Header shows a green **● Live** and the footer says `Build v1.3.0 · live SharePoint data` when you are on live data. An orange **SAMPLE DATA** bar means you are on made-up data (e.g. `Run-Demo.cmd` or an old copy of the app).
* Click **● Live** (or “Connection diagnostics” in Ctrl+K) to see what is working: data sources in the build, Power Apps context, the SharePoint connection, a REST test on a site.
* A column SharePoint refuses to return (some system columns) is skipped automatically instead of breaking the list.

## How to run
**A. Try it on your PC (no deployment, sample data):** unzip, double-click **`Run-Demo.cmd`** (installs Node.js if needed, then opens http://127.0.0.1:3000/?demo=1). Or in a terminal: `npm install` then `npm run dev`.

**B. Deploy to Power Platform:** unzip, double-click **`Deploy.cmd`**, enter your environment ID (the GUID in `make.powerapps.com/environments/<GUID>/…`). It installs Node/`pac` if missing, signs you in, wires the SharePoint connector, makes you the app owner, builds and publishes. Then open the app → **Connect** → pick the site and list/library → **Connect**, and share the app with your users.

## Forms for lists with many columns
* **Tabbed form on one screen**: lists with more than 8 editable columns open the New/Edit form as tabs (Essentials, Status & details 1/2, People & dates, Notes & links, Attachments). Tabs show how many **required** fields are still empty, jump to the first error on save, and work with arrow keys; **Back/Next** buttons move through them. Switch to **One page** any time.
* **Draft autosave** for new items (resume or discard after a crash or closed tab), **Duplicate** an existing item, quick date buttons, `Ctrl+Enter` to save.
* **Calendar view** over any date column: click a day to add an item on that date, drag an item to another day to reschedule it, "+n more" pop-ups.
* **Import from CSV**: map columns, validation per row (choices, numbers, dates, Yes/No, people), progress, and a downloadable file of skipped rows. Template download included.
* Ideas came from what the Power Apps community keeps asking for around SharePoint list apps (tabbed forms, calendar views, CSV import); the code-apps community itself publishes few public feature threads, so this is a judgment call.

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

## Document libraries (SharePoint-style)
* **Folder browsing** with breadcrumbs, folders first, plus an **All files** flat view; table, card and **tile gallery** layouts with colour-coded file-type icons (thumbnails for images in the live app).
* **New → Folder / Upload files / Upload folder**, drag-and-drop of files *and whole folders* (structure is recreated), progress per file, stop/retry feedback. Any file type. Uploads go through the SharePoint connector's *Create file* action, so keep files under ~100 MB (larger ones are skipped with a message).
* Row menu (⋯ or right-click): details, edit properties, **rename, move to…, copy to…**, download, copy link, manage access, delete (recycle bin). Version history tab.

## Lists: add / edit item
* Slide-in **form generated from the columns**: choice pills, multi-select chips, Yes/No switch, date quick-picks, number steppers, **people picker** (tenant directory), URL + text, notes with counter, **attachments** (add/remove), required-field progress bar, unsaved-changes guard, `Ctrl+Enter` to save, *Save & add another*.
* **Bulk edit** of selected rows, version history, attachments in the details panel, `N` shortcut for a new item.

## Security: who can access what
* **Manage access** on the list/library and on any **folder, file or list item**: see who has access, **stop/reset inheriting**, **add a person or group** with a permission level (Read, Contribute, Edit, Full Control, custom), remove access. Uses the real SharePoint permission APIs, so changes apply everywhere. Requires the *Manage permissions* right; others get a read-only “who has access” view.
* Views (saved filters/columns) can be limited to groups or admins; see *Views* above. SharePoint has no per-view permissions, so list *views* restrict what is shown, items/folders carry the real permissions.

## Search everywhere
`Ctrl+Shift+F` or **Search all**: searches every connected list/library at once, and offers one-click searches of the **Power Platform Community, Power Apps community, Microsoft Learn, Microsoft Q&A and Tech Community** (opened in a new tab; the app cannot call those sites itself).

## Board, favorites, share and record page
* **Board (Kanban)** for any list with a choice column (Status, Priority…): drag cards between columns to change the value (contributors/admins; keyboard users get a “Move to…” menu on each card). Group by any choice column.
* **Favorites**: star items (kept per user on this device) and filter to them in one click.
* **Share** (details panel, row menu): **copy an organization link** (view or edit) created through SharePoint’s sharing service, or open SharePoint’s own Share dialog for that item in a pop-up window (SharePoint does not allow its dialogs inside other pages, so it cannot be embedded; the pop-up page is undocumented and may not close itself). *Not verified against a live tenant: if it does not open, use “Open in SharePoint” and press Share there.*
* **Record page** for list items: status pills, progress ring, people and due date at a glance, and **click-to-change** status/Yes-No fields right in the details panel.
* **Links**: “Open in SharePoint” now encodes paths per segment and uses DispForm / `?web=1` for Office files / the library view for folders (the old links returned 404).
* **Personal views for everyone**: any user (including read-only) can save their own views; they are kept on the device and also in the cloud when the user may write to the settings list. Sharing a view with a group or admins still needs a data admin or owner.
* **Look and feel**: animated welcome banner, KPI sparklines and a health gauge, accent colour picker (PNC, teal, violet, rose, emerald) in Display.

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

---
Created by **Kirolos** — Power of Automation

## Deploy never asks which list to connect

`pac` can only register the SharePoint connector against *some* existing list, so the deploy script finds one itself (it lists the tables on your config site and tries them, then other sites you can reach). That list is only used to register the connector — **which list or library the app shows is chosen by the admin in the app's Connect screen.** The script registers SharePoint last (pac keeps only the connector it registers last), verifies the generated schema and the built bundle, and stops with a clear error instead of publishing a broken build. After deploying, the app footer must show the new build number; if it still shows an older one you are opening an older copy of the app.

### Copilot Studio connection check (v1.9.5)

**Assistant → Setup → Add Copilot Studio agent** has **Find my agents** (lists the agents your Copilot Studio connection can see, click to fill in the exact schema name) and a step-by-step **Test connection**: connector attached → your connection sees the agent → the agent answers (with timing). Error "The request was not sent or there was no response from the server" with no HTTP status means the Power Apps player never got a reply — most often the agent's synchronous call took too long (the player gives up after about 2 minutes), or a proxy/VPN/browser extension blocked the call. Use a classic agent set to *Authenticate with Microsoft*, published, and test from another network/browser; if it keeps timing out, wrap the agent in a Power Automate flow ("Execute Agent and wait" + "Respond to Power Apps").

### Which Copilot Studio agents work in-app

The in-app chat uses Microsoft's Copilot Studio connector, which only reaches **classic (standard) agents** — ones with Topics in the left menu. Agents from the newer *GitHub Copilot harness* experience (left menu: Skills, Connected agents, Authoring canvas, no Topics; Settings → Advanced shows an Entra Agent ID) are **not callable** by that connector today (Microsoft: microsoft/PowerAppsCodeApps discussion 434), and a Power Automate wrapper doesn't help because it uses the same connector. Options: (1) create a classic agent in the same environment, add the same SharePoint knowledge, set Authentication to *Authenticate with Microsoft*, publish and share it, then use **Find my agents**; (2) add the new-experience agent as a **link** (opens its chat; the app copies the context for you).

### Chat with new-experience Copilot Studio agents (v1.9.9)

Agents built in the newer Copilot Studio experience (Skills / Connected agents, no Topics) can't be reached through the Copilot Studio connector. Microsoft's Direct-to-Engine API does support them (rolling out through October 2026). In **Assistant → Setup → Add Copilot Studio agent (new or classic)** enter the **Environment ID** (pre-filled with this app's environment) and the **schema name** (Copilot Studio → Settings → Advanced → Metadata). The app talks to the agent through the **HTTP with Microsoft Entra ID (preauthorized)** connector:
1. Power Apps → Connections → New → *HTTP with Microsoft Entra ID (preauthorized)*; Base Resource URL = `https://<environment host>` (Setup shows and copies it), Resource URI = `https://api.powerplatform.com`.
2. `Deploy.cmd -AddEntraHttp` (or `pac code add-data-source -a shared_webcontents -c <connection id>`), republish; each user approves the connection once.
3. The agent must be published with *Authenticate with Microsoft*. If Microsoft Entra refuses the token for this resource, use the non-preauthorized connector with an Entra app that has `CopilotStudio.Copilots.Invoke`. Agent Builder / Microsoft 365 Copilot agents still have no API: add them as a link.

### Crash fix (v1.9.9)

A filter the server could not apply (multi-value people/lookup columns, relative dates from a colour-rule legend chip or a dashboard "Show items" button) made the grid page through the whole list automatically — thousands of requests and gigabytes of data — until the browser tab ran out of memory. The grid now stops after 10,000 non-matching rows and shows a "scan further" button, applies only the filters SharePoint could not apply, and resolves relative dates properly.
