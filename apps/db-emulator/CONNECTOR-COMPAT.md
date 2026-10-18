# How the emulator maps to the Power Platform connectors

"Same as the Power Platform connector" here means: **the same operations, option names, paging behaviour and response shapes that the Power Apps data SDK exposes for the SQL Server and Oracle tabular connectors**, so the dashboard code path is identical whether it reads from the emulator or from a real connection. It was built from the connectors' documented behaviour, **not** verified against a live tenant (none was available). The verification checklist at the end shows how to check it in yours.

## Operation mapping
| What the app does | Power Apps SDK call (real connection) | Connector operation | Emulator route |
|---|---|---|---|
| list tables | the tables added with `pac code add-data-source` (Diagnostics lists them) | Get tables | `GET /{engine}/datasets/{dataset}/tables` |
| read rows | `retrieveMultipleRecordsAsync(table, { filter, orderBy, select, top, skipToken })` | Get rows / items | `GET .../tables/{table}/items?$filter&$orderby&$select&$top&$skiptoken` |
| next page | `result.skipToken` | `@odata.nextLink` containing `$skiptoken` | `@odata.nextLink` with `$skiptoken=<n>` |
| run a query | `executeAsync({ connectorOperation: { operationName: 'ExecuteSqlQuery…' } })` | Execute a SQL query (V2) | `POST .../query/sql` |

The app's `fetchTable()` and `runSqlQuery()` take a `DbRef` (`sdk` or `emulator`) and share one paging loop and one result clean-up, so only the transport differs.

## Response shapes
* Tables: `{ "value": [{ "Name": "[dbo].[FactSales]", "DisplayName": "[dbo].[FactSales]" }] }` (SQL Server style names; Oracle and Teradata use `SCHEMA.TABLE`).
* Items: `{ "value": [ {row}, ... ], "@odata.nextLink": "...?$skiptoken=1000" }`; last page has no next link.
* Execute SQL: `{ "ResultSets": { "Table1": [ ... ] }, "OutputParameters": {}, "ReturnCode": 0 }`.
* Errors: `{ "status": 400, "message": "...", "error": { "message": "...", "code": 207 }, "source": "emulator-sql" }`.
* Types: SQL Server `bit` columns come back as booleans, datetimes as `2026-10-18T09:30:00`; Oracle `DATE` as `...T00:00:00`, column names upper case; Teradata timestamps with a space.

## OData subset ($filter)
`eq ne gt ge lt le`, `and or not`, parentheses, `null`, string / number / ISO date literals, `contains()`, `startswith()`, `endswith()`. Column names are validated; values are bound as parameters.

## Known differences from the real connectors (be aware)
1. **Page size**: the emulator pages at 1,000 rows. Real connectors page at their own size (and may ignore a large `$top`); the app loops on the token either way.
2. **Execute SQL**: the real operation takes a `query` body and may need stored-procedure style parameters; the emulator accepts `{ "query": ... }` and ignores parameters. Real SQL Server only runs SQL Server dialect; Oracle and Teradata connectors may not offer a free-form SQL operation at all (they are table / procedure oriented): in that case use tables or views.
3. **Dialects are simulated** (see README coverage). A query that works here can still fail on the real engine, and the reverse.
4. **Teradata**: I could not confirm that a Teradata connector (`shared_teradata`) is available for Power Apps code apps in your tenant. The app and deploy script treat it like SQL Server / Oracle (`-TeradataDataset`, `-TeradataTables`). If your tenant has no such connector, expose the data through a SQL Server / Oracle view, a custom connector, or an API and use the file or paste routes meanwhile.
5. **Auth**: real connections use the signed-in user's OAuth; the emulator is open on localhost (optional API key).
6. **Reachability**: from the browser preview (`npm run dev`) the app calls `http://127.0.0.1:3200` directly (CORS is enabled). From a published Power Apps page, Chrome and Edge allow loopback calls only with the `Access-Control-Allow-Private-Network` header (sent), and some environments block it: then test in the browser preview.

## Verification checklist in your tenant (15 minutes)
1. Deploy the app with one small real table (`-SqlTables 'dbo.YourSmallTable'`).
2. Open **Diagnostics**: the table and its connector operations should be listed.
3. Build a dashboard from that table through *Power Apps connection*; note row count, a total and the load time.
4. Mirror the same table into the emulator (same column names) or just compare behaviour: paging (does it load every row?), `$filter`/`$orderby` with your column names, `$top` beyond the connector's page size, datetime format, boolean columns.
5. Anything that differs goes into the `shapeRow` / `emuPage` mapping (one place each) or the real-connection path (`sdkPage` in `src/sources.ts`).
