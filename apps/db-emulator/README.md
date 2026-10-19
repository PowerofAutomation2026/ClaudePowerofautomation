# DB Emulator: simulated SQL Server, Oracle and Teradata with big live datasets

A local test server for **Live Dashboard Studio**. It stands in for three databases, each holding a realistic big dataset that keeps changing, and answers through REST endpoints shaped like the **Power Platform connectors** (tables, OData `$filter / $orderby / $select / $top / $skiptoken`, and "execute SQL").

> **It is a simulator, not the real engines.** It runs on SQLite and translates the common T-SQL, Oracle SQL and Teradata SQL used in reporting queries (coverage below). Anything else gets the engine's own style of error. Use it to build and test dashboards; test against the real databases before going live.

## Run it (needs Node 22.13 or newer: it uses the built-in SQLite)
```
cd apps/db-emulator
npm start                      # first start builds the data (about 20 s for 1.4 million rows), then serves on http://127.0.0.1:3200
npm start -- --size big        # 5x more rows (about 7 million, 1 GB on disk)
npm start -- --size small      # 2% of standard, instant
npm start -- --no-live         # data stays still
npm test                       # 15 test groups
```
Options: `--port 3200` `--host 127.0.0.1` `--data ./data` `--size small|standard|big|<number>` `--reseed` `--live-rate 1` `--page-size 1000` `--timeout 20000` (ms per query) `--api-key KEY`.
The data lives in `./data` (about 220 MB at standard size). Delete the folder or use `--reseed` to rebuild.

Then in **Live Dashboard Studio**: *Database (SQL / Oracle)*, choose **Local emulator (test)**, press **Connect**, pick an engine and a table (or write a query in that engine's dialect).

## The three databases
| Engine | Dataset | Tables (standard size) |
|---|---|---|
| **SQL Server** `emulator,SalesDW` | retail star schema + ITSM | `[dbo].[FactSales]` 300k · `[dbo].[ServiceNowIncidents]` 120k (26 columns: priority, SLA, team member, closed by ...) · `[dbo].[DimCustomer]` 50k · `[dbo].[DimProduct]` 2k · `[dbo].[DimStore]` 60 |
| **Oracle** `EMULATOR/ERPPROD` | ERP | `SALES.ORDERS` 200k · `FIN.GL_ENTRIES` 300k · `SALES.CUSTOMERS` 20k · `HR.EMPLOYEES` 1.5k · `HR.DEPARTMENTS` 12 (upper-case names, Oracle-style dates) |
| **Teradata** `emulator/EDW_PROD` | telecom CDRs | `EDW_PROD.CALL_DETAIL_FACT` 400k · `EDW_PROD.CUSTOMER_DIM` 40k · `EDW_PROD.TOWER_DIM` 500 · `EDW_PROD.PLAN_DIM` 10 |

All synthetic. Seasonality, weekends, popular products, log-normal amounts, new joiners with fewer tickets, SLA misses and blank cells for open tickets are built in.

**Live writer** (on by default): every second it inserts new sales, incidents, orders, GL entries and calls, and moves incidents and orders through their states (incident New to Resolved to Closed with the closing team member; order PENDING to PROCESSING to SHIPPED to DELIVERED). Dashboards with auto-refresh therefore move. `GET/POST /admin/live` shows or pauses it (`{"action":"pause"}`, `{"rate":3}`).

## Connector-shaped endpoints
Same pattern for `/{engine}/` = `sql`, `oracle`, `teradata`:

| Route | Meaning |
|---|---|
| `GET /{engine}/datasets` | datasets (SQL Server: `server,database`) |
| `GET /{engine}/datasets/{dataset}/tables` | `{ value: [{ Name, DisplayName }] }` (`[dbo].[FactSales]` / `SALES.ORDERS`) |
| `GET .../tables/{table}` | columns and row count |
| `GET .../tables/{table}/items?$filter&$orderby&$select&$top&$skiptoken` | `{ value: [...], "@odata.nextLink": ... }`, server-side paging (1000 rows a page) |
| `POST .../query/sql` `{ "query": "..." }` | `{ ResultSets: { Table1: [...] }, OutputParameters: {}, ReturnCode: 0 }` |
| `GET /health` | engines, tables, row counts, live-writer status |

Error bodies look like the connectors': `{ status, message, error: { message, code }, source }`. Details and known differences: **CONNECTOR-COMPAT.md**.

## Files and sharing endpoints (for the app's auto-refresh and Share features)
- `GET /files/folder?path=` lists files (from `<data>/files`, seeded from `files-seed/`: `sample-sales.csv`, `sample-sales.xlsx`); `GET /files/metadata?path=x.csv` returns name, size, modified time and ETag; `GET /files/content?path=x.csv` returns the file with `ETag` / `Last-Modified` (304 on `If-None-Match`); `PUT` writes it (413 above 25 MB); `DELETE` removes it. This mimics a SharePoint / OneDrive library closely enough to test "reload when the file changes".
- A background feed appends rows to `sales-feed.csv` every `--feed-sec` seconds (default 3; appends to `sales-feed.csv`); turn it off with `--no-feed`.
- `/shares` is a small share store: `GET /shares` (those visible to the `x-user` header), `POST` create, `GET/PUT/DELETE /shares/<id>` with view / edit / everyone permissions, optimistic version check (409 on conflict; definitions up to 2 MB) and optional data snapshots (up to 12 MB). Requests need an `x-user` email header (401 without). It trusts the `x-user` header: **testing only**.
- `/health` reports `files` and `shares`.

## SQL coverage (what the translators understand)
Read-only: one `SELECT` or `WITH ... SELECT`. Everything else is refused (INSERT, UPDATE, DELETE, DDL, EXEC, PRAGMA ...); queries run on a read-only connection in a separate process that is killed on timeout.

* **T-SQL**: `TOP n` / `TOP (n)`, `OFFSET .. FETCH NEXT`, `[brackets]`, `WITH (NOLOCK)`, `ISNULL`, `LEN`, `GETDATE`, `DATEADD`, `DATEDIFF`, `DATEPART`, `YEAR/MONTH/DAY`, `EOMONTH`, `CHARINDEX`, `CAST / CONVERT` with styles 23, 101, 103, 104, 108, 112, 120, 121, `IIF`, `CONCAT`, joins, CTEs, window functions.
* **Oracle**: `FETCH FIRST n ROWS ONLY`, `OFFSET`, `ROWNUM <= n`, `FROM DUAL`, `NVL`, `NVL2`, `DECODE`, `SYSDATE` (also `SYSDATE - 30`), `TRUNC`, `TO_CHAR` / `TO_DATE` / `TO_NUMBER`, `ADD_MONTHS` (month-end clamping), `MONTHS_BETWEEN`, `LAST_DAY`, `LISTAGG`, `MINUS`, `EXTRACT`, comma joins, double-quoted identifiers. Result column names are upper case.
* **Teradata**: `SEL`, `TOP n`, `SAMPLE n`, `QUALIFY ROW_NUMBER() / RANK() / DENSE_RANK() OVER (...) <op> n` (with `SELECT *`), `CURRENT_DATE - 30`, `CURRENT_DATE - INTERVAL 'n' DAY`, `DATE '2026-10-01'`, `ZEROIFNULL`, `NULLIFZERO`, `MOD`, `ADD_MONTHS`, `CHAR_LENGTH`, `INDEX`, `OREPLACE`, `CAST(.. AS DATE)`, `EXTRACT`, `GROUP BY 1, 2` ordinals.
* **Not supported (examples)**: stored procedures, temp tables, `PIVOT`, `CONNECT BY`, `MERGE`, `QUALIFY` with a column list, Teradata `SAMPLE .05` (fraction), recursive Oracle features, vendor system views. You get an error in the engine's style (`Msg 102`, `ORA-00933`, `[3706]`).

Errors you can expect, per engine: unknown table (`Invalid object name`, `ORA-00942`, `[3807]`), unknown column (`Msg 207`, `ORA-00904`, `[5628]`), syntax (`Msg 102`, `ORA-00933`, `[3706]`), write attempt (permission denied style), timeout (`Execution Timeout Expired`, `ORA-01013`, `[2631]`).

## Safety
Binds to `127.0.0.1` only by default. Read-only SQL, parameterized OData filters, a 100,000-row cap and a 20 s timeout per query, optional `--api-key`. It is a test tool: do not expose it to a network.
