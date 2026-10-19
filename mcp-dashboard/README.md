# Live Dashboard MCP server

An MCP server that lets **any agent** build and update **live dashboards**. The agent calls a tool, gets back a link,
and the page updates in real time (Server-Sent Events) every time the agent changes a widget.
Works with **Microsoft Copilot Studio** (Streamable HTTP) and with Claude Desktop / Claude Code (stdio).

```
Copilot Studio agent ──MCP (POST /mcp, API key)──▶ this server ──▶ Anthropic API (generate_dashboard)
                                                      └──SSE──▶ browser dashboard
```

## Run

```bash
npm install
API_KEY=choose-a-long-secret PUBLIC_URL=https://your-host npm start
```

| Env | Default | Meaning |
|---|---|---|
| `API_KEY` | random, printed at start | Required by `/mcp` (`Authorization: Bearer …` or `x-api-key: …`) |
| `ANTHROPIC_API_KEY` | – | Enables `generate_dashboard` (the server calls Anthropic's API). Without it the other tools still work. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model used to design dashboards. `claude-sonnet-5-5` is cheaper and faster. |
| `DATASOURCES_FILE` | `./datasources.json` | Data source definitions (see below) |
| `PUBLIC_URL` | derived from request | Base for the links returned to agents. Set it behind a proxy. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DATA_FILE` | `./data/dashboards.json` | Persistence. Mount a volume in containers. |

Deploy anywhere that serves HTTPS (`Dockerfile` included, e.g. Azure Container Apps / App Service). For a quick test from
your laptop use a dev tunnel: `devtunnel host -p 3000 --allow-anonymous` and set `PUBLIC_URL` to the tunnel URL.
Copilot Studio can only reach public HTTPS endpoints, so `localhost` will not work.

## Container deployment (e.g. Azure Container Apps)
```bash
docker build -t live-dashboard-mcp .
docker run -p 3000:3000 -e API_KEY=... -e PUBLIC_URL=https://your-host -v dash-data:/data live-dashboard-mcp
```
- Mount a volume at `/data` (Azure Files on Container Apps) for `dashboards.json` and your `datasources.json`.
- Run **one replica, minimum 1** (no scale-to-zero): dashboards live in memory/one file and the live page uses a long-lived stream.
- Put secrets (`API_KEY`, `ANTHROPIC_API_KEY`, DB passwords) in the platform's secret store and reference them as env vars.
- For SQL Server/Oracle, the container needs network access to the database (VNet integration for private databases), or use the Power Automate source instead.
- Ingress must be HTTPS and allow long-lived responses (idle timeout above 30 s; the server sends a ping every 25 s).

## Add it to a Copilot Studio agent

1. Open the agent → **Tools** → **Add a tool** → **New tool** → **Model Context Protocol**.
2. Server name `Live Dashboard`, description e.g. *"Creates and updates live dashboards"*, server URL `https://your-host/mcp`.
3. Authentication: **API key**, location **Header**, header name `x-api-key` (or `Authorization` with value `Bearer <key>`).
4. Create, make the connection with the key, **Add to agent**.
5. Tell the agent in its instructions: *"When the user wants a dashboard, call generate_dashboard with their request and any data, and share the returned url. To refresh it, call upsert_widget with the widget_id."*

(Copilot Studio's menu labels change occasionally; the server only needs a Streamable HTTP MCP URL and an API key.)

### Claude Desktop / Claude Code (stdio)
```json
{ "mcpServers": { "live-dashboard": { "command": "node", "args": ["/path/to/mcp-dashboard/src/server.js", "--stdio"],
  "env": { "PUBLIC_URL": "http://localhost:3000" } } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `generate_dashboard` | **Claude designs it:** pass a plain-language `prompt` and optional raw `data` (CSV/JSON/text); the server calls Anthropic, computes KPIs/charts/tables, publishes, returns the live `url`. Pass `dashboard_id` to rebuild in place (same link). |
| `build_dashboard` | One call: title + widgets → returns the live `url` |
| `create_dashboard`, `update_dashboard`, `delete_dashboard`, `list_dashboards`, `get_dashboard` | Manage dashboards |
| `upsert_widget` | Add a widget, or change one in place by `widget_id` (only the fields you pass change) |
| `append_point` | Push a new point to a line/bar widget for streaming data (rolls off old points) |
| `list_datasources`, `describe_datasource` | See configured data sources and preview their columns |
| `bind_widget` | Create/update a widget bound to a data source, so it auto-refreshes |
| `refresh_now` | Force a refresh of a dashboard's bound widgets |
| `remove_widget` | Delete a widget |

Widget types: `kpi` (value, unit, delta, good_direction), `line`, `bar` (labels + values, or multiple `series`),
`pie`, `table` (columns + rows), `text`. Schemas are deliberately flat so Copilot Studio's orchestrator fills them reliably.

## Live data sources (auto-refreshing widgets)

Bind widgets to Excel, CSV, SQL Server, Oracle or Power Platform data and they refresh on their own while the dashboard is open.

1. Copy `datasources.example.json` to `datasources.json` (or set `DATASOURCES_FILE`) and define your sources. Secrets use `"env:NAME"` references.
2. The **agent never sees connection details and never writes SQL**. It can only pick a source and a *named query* you defined. Queries must be a single `SELECT`/`WITH`, validated when the config loads. Still use a **read-only database account**.
3. The agent calls `list_datasources` → `describe_datasource` (column names + 5 sample rows) → `bind_widget`. Example instruction for the agent:
   *"For sales dashboards, bind widgets to the `erp_sql` source: a kpi on `revenue` (sum), a line chart of `orders_by_day` (label `day`, values `revenue`), a table of `top_customers`."*

| Source `type` | Reads from | Notes |
|---|---|---|
| `csv` | local path or http(s) URL | Auto-detects `, ; tab`. URLs use ETag / Last-Modified so unchanged files aren't re-downloaded. |
| `excel` | `.xlsx` path or URL (`sheet` optional) | First row = headers. Formula cells use their cached result. |
| `sqlserver` | `mssql` driver | Pooled connection, reconnects after network errors. |
| `oracle` | `oracledb` thin mode | No Oracle Client install needed (Oracle 12.1+). |
| `powerautomate` | HTTP-triggered flow | The **Power Platform route**, below. |

**Refresh behaviour.** Each source polls every `refreshSeconds` (minimum 5), but only while someone has the dashboard open, so idle dashboards never hit your database. Opening a dashboard refreshes it immediately. If a refresh fails, the widget keeps its last data and shows the error. Rows are capped at 50,000 per query (`MAX_SOURCE_ROWS`); keep queries aggregated.

### Using the Power Platform connectors (SQL Server / Oracle / Excel Online / SharePoint)
When the server can't reach the database directly (on-prem, VNet-only) or the data lives in Excel Online / SharePoint / OneDrive, let a flow do the reading:

1. Power Automate → new flow, trigger **When an HTTP request is received** (any user can call; the URL's `sig` is the secret).
2. Add a **Switch** on `triggerBody()?['query']`. In each case use the connector action (**SQL Server – Execute a SQL query (V2)**, **Oracle Database – Get rows**, **Excel Online – List rows present in a table**) through your data gateway.
3. **Response** action, status 200, header `Content-Type: application/json`, body = the rows (for SQL: `body('Execute_a_SQL_query_(V2)')?['resultsets']?['Table1']`), shaped as a JSON array of objects.
4. Put the flow URL in an env var, reference it as `"url": "env:PP_FLOW_URL"`, and list the case names under `queries` (the value text is ignored; the flow owns the logic).

Flow limits apply (run time ~2 minutes sync, payload size, API-call quotas), so use a `refreshSeconds` of 60+ and aggregate in the flow.

## Security notes
- `generate_dashboard` sends the prompt and data you pass to Anthropic's API, and each call costs tokens (billed to `ANTHROPIC_API_KEY`). Data is capped at ~400k characters per call.
- `/mcp` needs the API key. Dashboard pages need the per-dashboard `?t=` token in the link, so anyone with the link can view that one dashboard; deleting the dashboard revokes it.
- The server is stateless per request, so it scales out, but dashboards live in one JSON file; use one instance (or swap `Store` for a database) if you need more.
- Don't put secrets or regulated data in widgets unless the link is protected appropriately (e.g. put the viewer behind your own SSO proxy).

## Test
`npm test` starts the server and drives it through the real MCP client (auth, build, live SSE push, validation).
