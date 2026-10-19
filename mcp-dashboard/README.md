# Live Dashboard MCP

An MCP server that lets a **Copilot Studio agent (running a Claude model)** build **live dashboards**, optionally wired to
**Excel, CSV, SQL Server and Oracle** data (directly, or through Power Platform connectors via Power Automate).
The agent calls a tool and gets a link. The page updates in real time and refreshes its own data.

```
Copilot Studio agent (Claude) ──MCP /mcp──▶ this server ──▶ Excel/CSV · SQL Server · Oracle · Power Automate flows
        no Anthropic key needed                  └──live stream──▶ browser dashboard (KPIs, charts, tables, alerts)
```

## Quick start (zero touch, Azure)

```powershell
./Deploy.cmd                                   # or: ./Deploy-LiveDashboardMcp.ps1
./Deploy-LiveDashboardMcp.ps1 -EnvironmentId <power-platform-env-guid> -DataSourcesFile ./datasources.json `
    -Secrets @{ ERP_USER='readonly'; ERP_PASSWORD='...' }
```
It installs/validates Azure CLI, signs you in, builds the image **in Azure** (no local Docker), deploys to **Azure Container Apps**
(1 replica, HTTPS, secrets in the platform secret store, persistent storage), generates the server key, checks the live
server, and creates a **Copilot Studio custom connector** (needs the Power Platform CLI; skipped if you give no environment).
It ends by printing the MCP URL, the server key and the exact next steps. Re-running updates in place and keeps the key.
**No Azure app registration is created or needed.** Remove everything with `-Remove`.

Options: `-Name -ResourceGroup -Location -Subscription -ApiKey -AnthropicApiKey -AlertWebhookUrl -SkipConnector -SkipPrereqInstall`.

> Status: the script was syntax-checked with PowerShell 7 and run end to end against a *simulated* `az`/`pac`
> (control flow, generated container spec, secrets wiring, health/auth checks, re-run). It has **not** been run against a real Azure
> subscription or tenant. Treat the first run as a pilot in a test resource group.

## Add it to a Copilot Studio agent

The server hosts its own setup page at `https://<your-host>/` with copy buttons for everything below.

| Option | Steps | Needs |
|---|---|---|
| **A. OAuth dynamic discovery** (easiest) | Tools → Add a tool → New tool → Model Context Protocol → URL `https://<host>/mcp` → Authentication **OAuth 2.0 → Dynamic discovery**. A sign-in page from this server opens: enter the **server key**. | nothing else; no Entra app registration |
| **B. API key** | Same wizard, Authentication **API key**, Header, name `x-api-key`, value = server key | |
| **C. Custom connector** | The deploy script creates it. Manual: import `/copilot-studio/connector.swagger.json` + `connector.properties.json` (Power Apps → Custom connectors, or `pac connector create`) | |

Then set the agent's **model to Claude** (if Anthropic models are enabled in your tenant) and paste the instructions from
`/copilot-studio/agent-instructions.md` into the agent. Claude designs the dashboard; this server draws it. **No Anthropic API key is needed**
(`generate_dashboard`, which calls Anthropic from the server, is optional and only enabled when `ANTHROPIC_API_KEY` is set).

## Features
- **Widgets:** KPI, line, bar, pie, table, text. Light/dark, responsive, fullscreen button, CSV download on tables.
- **KPI extras:** sparkline, automatic change vs the previous reading, **warn / critical thresholds** (amber / red).
- **Alerts:** set `ALERT_WEBHOOK_URL` (a Power Automate HTTP flow, Teams workflow, Slack...) and get a JSON POST when a KPI turns warning, critical or recovers.
- **Live data:** widgets bound to a data source refresh on their own while the dashboard is open. Only while someone is watching, so idle dashboards never hit your databases.
- **Dynamic discovery:** the agent lists allow-listed SQL Server / Oracle tables, sees columns and sample rows, and binds widgets with `table` + `filters`. The server builds parameterised SQL; **the agent never writes SQL**.
- **Sharing:** every dashboard has an unguessable link; `rotate_link` revokes and reissues it. Dashboards embed in Teams tabs / iframes.
- **Auth:** OAuth 2.1 dynamic discovery (DCR + PKCE, stateless, nothing stored) and/or API key.

## Tools

| Tool | Purpose |
|---|---|
| `list_datasources` · `describe_datasource` | See configured sources; preview columns/rows of CSV, Excel, named queries, flows |
| `list_tables` · `describe_table` | Browse allow-listed SQL Server / Oracle tables and columns |
| `bind_widget` | Create/update a widget bound to a source (named `query` or `table` + `filters`); auto-refreshing; supports thresholds |
| `refresh_now` | Force a refresh |
| `create_dashboard` · `build_dashboard` · `update_dashboard` · `delete_dashboard` · `list_dashboards` · `get_dashboard` · `rotate_link` | Manage dashboards (`build_dashboard` = one call with static widgets) |
| `upsert_widget` · `append_point` · `remove_widget` | Static widgets and streaming points |
| `generate_dashboard` | Optional: the server asks Anthropic's API to design a dashboard from a prompt + raw data |

Tool schemas are deliberately flat (no `$ref`/`anyOf`/type arrays; a test enforces it) so Copilot Studio fills them reliably.

## Data sources
Copy `datasources.example.json` to `datasources.json` (the deploy script uploads it with `-DataSourcesFile`). Secrets are `"env:NAME"` references.

| `type` | Reads | Notes |
|---|---|---|
| `csv` / `excel` | local path or http(s) URL | ETag-aware; Excel: first row = headers, `sheet` optional, formulas use cached result |
| `sqlserver` / `oracle` | `mssql` / `oracledb` (thin mode, no client install) | `queries` = named admin SQL; `discover.include` = glob allow-list for tables (`"dbo.*"`, optional `exclude`) |
| `powerautomate` | HTTP-triggered flow | The Power Platform route: the flow uses the SQL Server / Oracle / Excel Online / SharePoint connectors (through the data gateway) and returns a JSON array |

**Power Automate flow recipe:** trigger *When an HTTP request is received* → *Switch* on `triggerBody()?['query']` → connector action per case →
*Response* (200, `Content-Type: application/json`, body = the rows as an array). List the case names under `queries` in the config.

Behaviour: each source polls every `refreshSeconds` (min 5) while its dashboard is open; a viewer joining refreshes immediately; a failed refresh keeps the last data and shows the error.
Rows are capped at 50,000 per query (`MAX_SOURCE_ROWS`); table-mode aggregates in the database.

## Security model
- `/mcp` requires the server key (`x-api-key` / `Authorization: Bearer`) or an OAuth token issued after entering the key. Rotating `API_KEY` revokes all tokens.
- Viewer links carry a per-dashboard token. Anyone with the link sees that one dashboard; `rotate_link` or `delete_dashboard` revokes it.
- The agent never sees connection strings and cannot read arbitrary files or run arbitrary SQL: sources and queries come only from the admin's config; table mode uses catalog-validated identifiers and bound parameters; non-SELECT statements are rejected. **Still use read-only database accounts.**
- `generate_dashboard` (if enabled) sends the prompt and data to Anthropic's API and costs tokens.
- Don't put regulated data on a dashboard unless its link is protected appropriately.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `API_KEY` | random, printed at start | Server key |
| `PUBLIC_URL` | derived from request | Base for returned links and OAuth metadata. Set it behind a proxy. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DATA_FILE` | `./data/dashboards.json` | Persistence (mount a volume) |
| `DATASOURCES_FILE` | `./datasources.json` | Data source definitions |
| `ALERT_WEBHOOK_URL` | – | Threshold alert receiver |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | – / `claude-opus-5-5` | Only for `generate_dashboard` |
| `MAX_SOURCE_ROWS` | `50000` | Row cap per query |

## Run locally / other hosts
```bash
npm install
API_KEY=choose-a-long-secret PUBLIC_URL=http://localhost:3000 npm start      # http://localhost:3000/ shows the setup page
npm test                                                                      # 32 tests, no external services
```
Docker: `docker build -t live-dashboard-mcp . && docker run -p 3000:3000 -e API_KEY=... -e PUBLIC_URL=https://host -v dash:/data live-dashboard-mcp`.
Claude Desktop / Claude Code (stdio): `{"command":"node","args":["/path/src/server.js","--stdio"],"env":{"PUBLIC_URL":"http://localhost:3000"}}`.
Run **one replica** (dashboards live in one file and the live page keeps a connection open). Copilot Studio can only reach public HTTPS endpoints.

## Verification status
Tested automatically: MCP protocol, both auth modes including the MCP SDK completing the full OAuth discovery/registration/PKCE flow, KPI thresholds and alerts,
CSV/Excel/HTTP/flow sources, refresh engine, SQL generation for SQL Server and Oracle (including injection attempts), the viewer in a real browser, the deploy script against a simulated Azure CLI.
**Not tested** (no access from the build environment): a real Azure deployment, a real Copilot Studio tenant (including whether your tenant offers Claude models and how the wizard's labels read today),
a live SQL Server or Oracle instance, Oracle date handling beyond `YYYY-MM-DD`, and the Docker image build. Pilot each before relying on it.
