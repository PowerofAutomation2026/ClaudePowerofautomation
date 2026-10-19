# Live Dashboard Studio

A Power Apps **code app** (React + TypeScript) that turns data into a live dashboard on the fly:

- **Drop a file** (CSV, TSV, JSON, Excel .xlsx) or **paste cells**: the dashboard builds itself in a second.
- **Connect a database** (SQL Server, Oracle, Teradata, Dataverse tables) through your own Power Apps connections.
- **Test with big simulated databases**: `apps/db-emulator` is a local SQL Server / Oracle / Teradata simulator (1.4 million rows, live inserts, each engine's SQL dialect and error style) that answers in the shape of the Power Platform connectors.
- **Live**: database dashboards refresh on a timer (5 s to 5 min, pause / resume); file dashboards update when you **replace the data**, or automatically when you **watch a local file** (Chromium browsers).
- Click any bar or slice to **filter the whole dashboard**; date-range presets; table view of every chart; export CSV / layout JSON / print to PDF.
- **No Azure app registration.** Database calls run on the signed-in user's own connector connection.

## Try it now (no setup)
```bash
cd apps/live-dashboard-studio
npm install
npm run dev          # http://127.0.0.1:3100 : upload sample-sales.csv, or click "Try the live demo"
npm test             # 27 engine tests (parsing, type detection, aggregation, auto layout)
npm run build        # type-check + bundle
```
In the browser preview, files, pasted data and the simulated live demo work. Database tables need the app to run inside Power Apps.

## Deploy to Power Apps
```powershell
./scripts/Deploy-LiveDashboardStudio.ps1                                   # files + paste + demo only
./scripts/Deploy-LiveDashboardStudio.ps1 -EnvironmentId <guid> `
    -SqlServer myserver.database.windows.net -SqlDatabase Sales -SqlTables 'dbo.Orders','dbo.Customers' `
    -OracleDataset <oracle-dataset> -OracleTables 'SALES.ORDERS' `
    -TeradataDataset <teradata-dataset> -TeradataTables 'EDW_PROD.CALL_DETAIL_FACT' `
    -DataverseTables account,opportunity
```
(`Deploy.cmd` is the same for Windows double-click.) The script installs Node and `pac` if missing, signs you in, opens the Connections page if the SQL / Oracle connection does not exist yet (OAuth sign-in cannot be scripted), adds each table with `pac code add-data-source`, builds and runs `pac code push`. Re-run it with more tables any time.

Requirements: Power Apps premium licence for the users (code apps + premium connectors) and code apps enabled on the environment. SQL Server on-premises and Oracle need an **on-premises data gateway** for the connection.

## Database sources
**No database to hand? Use the emulator.** Start `apps/db-emulator` (`npm start`), then *Database (SQL / Oracle)* > **Local emulator (test)** > Connect. You get three engines with big tables and a live writer, and can type queries in T-SQL, Oracle SQL or Teradata SQL. See `../db-emulator/README.md` and `CONNECTOR-COMPAT.md` there.

**Real databases** (inside Power Apps):
Every table added with `pac code add-data-source` appears in **Database (SQL / Oracle)** > Table. You choose max rows (default 5,000, up to 200,000), an optional OData `filter`, sort and column list, and a live refresh interval. The app reads through the SDK (`retrieveMultipleRecordsAsync`, paged with `skipToken`).

**SQL query (advanced)** runs one `SELECT` through the connector's *Execute a SQL query* operation, only if that operation exists in the app's generated data-source info. If it does not, the app says so and you can use a table or a database view instead (a view is the recommended way to give a dashboard a ready-made query).

Open **Diagnostics** to see which tables and connector operations the app found, and a log of the last loads and errors.

## Auto-refresh
**Databases (SQL Server / Oracle / Teradata):** pick *Live refresh* (every 5 s to 5 min) when you connect. Each check re-reads the data and compares a fingerprint of every value; if nothing changed the dashboard is left alone ("no changes" in Diagnostics), if something changed it is rebuilt and the status chip shows what changed. If the database is unreachable the last good data stays on screen, the status says "Update failed", the error is explained, and retries slow down (x2 up to 5 min) and recover by themselves.

**Files (CSV / Excel / JSON):** the app watches the file and reloads when it changes.
- **Watch a file on a server** (sidebar) offers: *Test file share* (emulator `/files`), *Web link* (any URL that answers HEAD with ETag / Last-Modified / size), *SharePoint* and *OneDrive* (through the connector, deploy with `-SharePoint` / `-OneDrive`). Choose a check interval (5 s to 10 min), and for Excel a sheet name.
- **Watch file** on a local file (Chromium File System Access) reloads when the file on disk changes.
- Only the cheap "did it change" signature is polled; the file is downloaded and parsed again only when that signature changes. A deleted or locked file shows an error and recovers when it comes back. Watch settings are saved with the dashboard.

## Sharing dashboards with other users
Open a dashboard and press **Share**.
- Choose where the shared definition is stored: the **test emulator** (`/shares`, tested) or **SharePoint** (one `<id>.lds.json` file per dashboard in a library you pick; experimental, untested).
- Add people (email / UPN) as **can view** or **can edit**, or set *Everyone* to view / edit. Viewers get a read-only dashboard; editors can change widgets and **Save to shared**. Saves are versioned: if someone saved a newer version first you get "Version conflict" instead of overwriting it, and **reload** brings in theirs.
- Everyone with the dashboard open picks up changes automatically (polled every 15 s). If you have unsaved edits when a newer version arrives you are warned before anything is replaced.
- **Database dashboards** share the *definition* (table, filter, sort, widgets); each person's own connection reads the data, so access follows each person's database permissions.
- **File / pasted dashboards** can be shared with a **data snapshot** (up to 50,000 rows); later changes are pushed with **Save to shared**. Stop sharing keeps everyone's private copy.
- **Copy link** gives a deep link (`?share=<id>`) to the shared dashboard; **Copy layout link** gives a self-contained `#share=` link with the layout only (no data, no server).
- In the test setup, identity is a name you type (**Who am I**, stored as `lds.devUser`). Inside Power Apps the signed-in user comes from the SDK.

## How the dashboard builds itself
Column types are detected (number, date, text; ID-like numbers are treated as categories). Then:
- KPI tiles: row count and the first numeric columns (average for rate / price / score style names, total otherwise)
- Line chart: first numeric column over the first date column (day / week / month / year chosen from the date span)
- Bar charts: numeric measure by low-cardinality text columns
- Donut: share by a column with up to 6 values (rest folded into "Other")
- Data table with search and sorting

**Edit** lets you add / remove / reorder widgets and choose dimension, measure, calculation (sum, average, count, min, max, distinct), time step, top N and width. **Rebuild widgets automatically** resets the layout. When data is replaced with different columns, widgets that lost a column show a clear message instead of breaking.

Charts follow a validated colour palette (light and dark), colour stays with the category when you filter, every chart has a table view, and nothing is color-only.

## Where things are saved
Dashboard layouts live in this browser (localStorage); file data lives in IndexedDB. Database dashboards store only the table / query settings and reload the data when opened. Use **Export > Dashboard layout** and **Import layout** to move a dashboard to another browser or person. Clearing site data removes everything.

## Limits (be aware)
- PDF tables are not read: export to CSV or Excel first. Old `.xls` is not supported (save as `.xlsx`).
- **Big data:** up to **200,000 rows** are kept in the browser (files up to 60 MB). If a file or query has more, the app shows a warning with the real numbers ("Only the first 200,000 of 300,000 rows were loaded") because totals then cover only the loaded rows. Cut the data down at the source: a database filter or view, or split the file.
- Datasets above **100,000 rows are not saved** in the browser (saving would freeze the page); the layout is kept and you add the file again after a reload. Database dashboards reload from the database anyway.
- Big files load in slices with a progress bar, so the page stays usable. Excel (.xlsx) files cannot be sliced by the library: very large workbooks can pause the page for several seconds, so use CSV for 100k+ rows.
- Date detection: ISO (`2026-10-18`, with or without time) and `M/D/YYYY` (`D/M/YYYY` when the first part is above 12).
- Local "Watch file" needs a Chromium browser and may be blocked inside the Power Apps frame; then use a server file watch or **Replace data**.
- Sharing: SharePoint storage permissions are the real access control (folder permissions); the people list inside the shared file is advisory there. The emulator trusts the `x-user` header and is for testing only. Data access is always the viewer's own.
- No sign-in layer of its own: access is whatever Power Apps sharing allows. Data shown comes from the user's own connections.

## Honest status
Tested in this build: the data engine (28 unit tests, including 100k rows aggregated in under 1.5 s and the row-cap warning) and the full browser experience against the production bundle (upload CSV and Excel, paste, multi-file, cross-filtering, date range, replace-data with change deltas, saved layouts and data surviving reload, the live demo refreshing by itself, dark mode, phone width, no console errors).

**Measured with big files** (headless Chromium, production build): a 150,000-row CSV (7 MB) was ready in about 2 s with the longest page stall under 0.4 s and an exact total; a click-to-filter took about 160 ms and table search about 90 ms. A 300,000-row CSV loaded the first 200,000 rows in about 4 s and showed the warning. Your computer and Power Apps frame may be slower.

**Also tested in the browser against the emulator:** database auto-refresh (new rows arrive, unchanged data not rebuilt, outage + back-off + recovery), file auto-refresh (CSV, XLSX, web link ETag, pause / resume, missing file, reload persistence: 24 checks) and multi-user sharing (view vs edit, auto-sync, version conflict, everyone, deep link, stop sharing, snapshots, layout links: 44 checks).

**Not tested** (no tenant here): SharePoint / OneDrive file operations and the SharePoint share storage, the real SQL / Oracle / Dataverse reads, `pac code push`, and the deploy script. The SDK calls follow the installed `@microsoft/power-apps` 1.5.0 typings, but the first run in your tenant is a pilot: open **Diagnostics**, add one small table, and check it loads. The `pac code add-data-source` flags (`-a`, `-c`, `-d`, `-t`) should be confirmed with `pac code add-data-source --help`; the script warns if `-d` is missing. Oracle is the least certain connector for code apps, and I could not confirm a Teradata connector for Power Apps code apps in your tenant (see the emulator's CONNECTOR-COMPAT.md).

## Layout
```
src/engine.ts    parsing, type detection, aggregation, auto layout (pure, unit-tested)
src/files.ts     file watching: change signatures + fetch (url, emulator, SharePoint, OneDrive)
src/share.ts     sharing: backends (emulator, SharePoint), permissions, layout links
src/sources.ts   files, SQL / Oracle / Dataverse via the SDK, simulated live source
src/store.ts     localStorage + IndexedDB persistence
src/charts.tsx   SVG/HTML charts: KPI, bars, line, donut, tables, tooltips
src/App.tsx      screens, live refresh loop, filters, editor, diagnostics
tests/           engine tests (node --experimental-strip-types)
scripts/         Deploy-LiveDashboardStudio.ps1
```
