# Live Dashboard Studio

A Power Apps **code app** (React + TypeScript) that turns data into a live dashboard on the fly:

- **Drop a file** (CSV, TSV, JSON, Excel .xlsx) or **paste cells**: the dashboard builds itself in a second.
- **Connect a database** (SQL Server, Oracle, Dataverse tables) through your own Power Apps connections.
- **Live**: database dashboards refresh on a timer (5 s to 5 min, pause / resume); file dashboards update when you **replace the data**, or automatically when you **watch a local file** (Chromium browsers).
- Click any bar or slice to **filter the whole dashboard**; date-range presets; table view of every chart; export CSV / layout JSON / print to PDF.
- **No Azure app registration.** Database calls run on the signed-in user's own connector connection.

## Try it now (no setup)
```bash
cd apps/live-dashboard-studio
npm install
npm run dev          # http://127.0.0.1:3100 : upload sample-sales.csv, or click "Try the live demo"
npm test             # 25 engine tests (parsing, type detection, aggregation, auto layout)
npm run build        # type-check + bundle
```
In the browser preview, files, pasted data and the simulated live demo work. Database tables need the app to run inside Power Apps.

## Deploy to Power Apps
```powershell
./scripts/Deploy-LiveDashboardStudio.ps1                                   # files + paste + demo only
./scripts/Deploy-LiveDashboardStudio.ps1 -EnvironmentId <guid> `
    -SqlServer myserver.database.windows.net -SqlDatabase Sales -SqlTables 'dbo.Orders','dbo.Customers' `
    -OracleDataset <oracle-dataset> -OracleTables 'SALES.ORDERS' `
    -DataverseTables account,opportunity
```
(`Deploy.cmd` is the same for Windows double-click.) The script installs Node and `pac` if missing, signs you in, opens the Connections page if the SQL / Oracle connection does not exist yet (OAuth sign-in cannot be scripted), adds each table with `pac code add-data-source`, builds and runs `pac code push`. Re-run it with more tables any time.

Requirements: Power Apps premium licence for the users (code apps + premium connectors) and code apps enabled on the environment. SQL Server on-premises and Oracle need an **on-premises data gateway** for the connection.

## Database sources
Every table added with `pac code add-data-source` appears in **Database (SQL / Oracle)** > Table. You choose max rows (default 5,000, up to 200,000), an optional OData `filter`, sort and column list, and a live refresh interval. The app reads through the SDK (`retrieveMultipleRecordsAsync`, paged with `skipToken`).

**SQL query (advanced)** runs one `SELECT` through the connector's *Execute a SQL query* operation, only if that operation exists in the app's generated data-source info. If it does not, the app says so and you can use a table or a database view instead (a view is the recommended way to give a dashboard a ready-made query).

Open **Diagnostics** to see which tables and connector operations the app found, and a log of the last loads and errors.

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
- "Watch file" needs a Chromium browser and may be blocked inside the Power Apps frame; then use **Replace data**.
- No sign-in layer of its own: access is whatever Power Apps sharing allows. Data shown comes from the user's own connections.

## Honest status
Tested in this build: the data engine (25 unit tests, including 100k rows aggregated in under 1.5 s and the row-cap warning) and the full browser experience against the production bundle (upload CSV and Excel, paste, multi-file, cross-filtering, date range, replace-data with change deltas, saved layouts and data surviving reload, the live demo refreshing by itself, dark mode, phone width, no console errors).

**Measured with big files** (headless Chromium, production build): a 150,000-row CSV (7 MB) was ready in about 2 s with the longest page stall under 0.4 s and an exact total; a click-to-filter took about 160 ms and table search about 90 ms. A 300,000-row CSV loaded the first 200,000 rows in about 4 s and showed the warning. Your computer and Power Apps frame may be slower.

**Not tested** (no tenant here): the real SQL / Oracle / Dataverse reads, `pac code push`, and the deploy script. The SDK calls follow the installed `@microsoft/power-apps` 1.5.0 typings, but the first run in your tenant is a pilot: open **Diagnostics**, add one small table, and check it loads. The `pac code add-data-source` flags (`-a`, `-c`, `-d`, `-t`) should be confirmed with `pac code add-data-source --help`; the script warns if `-d` is missing. Oracle is the least certain connector for code apps.

## Layout
```
src/engine.ts    parsing, type detection, aggregation, auto layout (pure, unit-tested)
src/sources.ts   files, SQL / Oracle / Dataverse via the SDK, simulated live source
src/store.ts     localStorage + IndexedDB persistence
src/charts.tsx   SVG/HTML charts: KPI, bars, line, donut, tables, tooltips
src/App.tsx      screens, live refresh loop, filters, editor, diagnostics
tests/           engine tests (node --experimental-strip-types)
scripts/         Deploy-LiveDashboardStudio.ps1
```
