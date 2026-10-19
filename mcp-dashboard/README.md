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
| `PUBLIC_URL` | derived from request | Base for the links returned to agents. Set it behind a proxy. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DATA_FILE` | `./data/dashboards.json` | Persistence. Mount a volume in containers. |

Deploy anywhere that serves HTTPS (`Dockerfile` included, e.g. Azure Container Apps / App Service). For a quick test from
your laptop use a dev tunnel: `devtunnel host -p 3000 --allow-anonymous` and set `PUBLIC_URL` to the tunnel URL.
Copilot Studio can only reach public HTTPS endpoints, so `localhost` will not work.

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
| `remove_widget` | Delete a widget |

Widget types: `kpi` (value, unit, delta, good_direction), `line`, `bar` (labels + values, or multiple `series`),
`pie`, `table` (columns + rows), `text`. Schemas are deliberately flat so Copilot Studio's orchestrator fills them reliably.

## Security notes
- `generate_dashboard` sends the prompt and data you pass to Anthropic's API, and each call costs tokens (billed to `ANTHROPIC_API_KEY`). Data is capped at ~400k characters per call.
- `/mcp` needs the API key. Dashboard pages need the per-dashboard `?t=` token in the link, so anyone with the link can view that one dashboard; deleting the dashboard revokes it.
- The server is stateless per request, so it scales out, but dashboards live in one JSON file; use one instance (or swap `Store` for a database) if you need more.
- Don't put secrets or regulated data in widgets unless the link is protected appropriately (e.g. put the viewer behind your own SSO proxy).

## Test
`npm test` starts the server and drives it through the real MCP client (auth, build, live SSE push, validation).
