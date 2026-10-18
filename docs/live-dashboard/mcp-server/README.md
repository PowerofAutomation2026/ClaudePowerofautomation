# Live Dashboard MCP server for Copilot Studio (no Azure app registration)

One small server that is three things:
1. An **MCP server** (`/mcp`) with tools `create_dashboard`, `update_dashboard`, `list_dashboards`. Copilot Studio adds it as a tool.
2. A **dashboard host**: each dashboard gets a link `https://YOUR-HOST/d/<id>` that shows totals, charts and a table, and re-reads its data every minute.
3. A **REST endpoint** (`/api/upload`) so a flow can send every new file automatically.

Security: API key in the `x-api-key` header, so no Azure/Entra app registration or OAuth is needed. Dashboard links use a random 128-bit id: anyone who has the link can view that dashboard (no sign-in), so do not share links outside your team. The data is stored on the machine that runs this server, so host it somewhere your company controls.

Tested here: server start, API key check, MCP initialize / tools list / tools call, create, update (same link), list, empty-file error, dashboard page in a browser including a refresh after an update. NOT tested: Copilot Studio adding it, or any hosting service.

## 1. Run it on your computer first (2 min)
You need Node 18+.
```
cd docs/live-dashboard/mcp-server
API_KEY=pick-a-long-random-string node server.mjs        (Mac/Linux)
set API_KEY=pick-a-long-random-string && node server.mjs  (Windows cmd)
```
Open http://localhost:3000/health (should show ok). Self-test: `npm test`.
Create a dashboard by hand:
```
curl -X POST http://localhost:3000/api/upload -H "x-api-key: pick-a-long-random-string" -H "content-type: application/json" -d "{\"name\":\"sales.csv\",\"csv_text\":\"Date,Region,Units\n2026-10-01,North,5\n2026-10-02,South,7\"}"
```
Open the `url` in the reply.

## 2. Put it on the internet (Copilot Studio needs an https address)
Copilot Studio cannot reach localhost. Pick one host that runs Node or Docker and gives you an https URL:
- **Azure App Service (Web App, Node 22)**: deploy this folder, then Settings, Environment variables: add `API_KEY` (long random string) and `PUBLIC_URL` (your https address). No app registration is involved; you only create a web app. Turn on "Always on" and use a persistent path for `DATA_DIR` (for example `/home/data`), or data may reset on redeploy.
- **Any container host** (Render, Railway, Fly.io, an internal server): use the included `Dockerfile`, set `API_KEY` and `PUBLIC_URL`, and mount a disk at `/data`.
- **Quick test only**: a tunnel such as ngrok or Dev Tunnels to your running local server. Not for real use.
Check `https://YOUR-HOST/health` returns `{"ok":true}`.

## 3. Add it to your Copilot Studio agent
New experience:
1. Open your agent, **Build**, **Tools**, **Add a tool**, **New tool**, **Model Context Protocol**.
2. Server name: `Live Dashboard`. Description: "Creates and updates live dashboards from CSV or row data and returns a link."
3. Server URL: `https://YOUR-HOST/mcp`.
4. Authentication: **API key**. Type: Header. Header name: `x-api-key`. Create, then enter your key when it asks for the connection.
5. Select the three tools, then **Add and configure**.
Legacy experience: **Tools** tab, **Add a tool**, **New tool**, **Model Context Protocol**, same values.
If your tenant has no MCP option, use the connector route below. If the key option is missing, ask your admin whether MCP and custom tools are enabled for the environment.

Then paste `agent-instructions-mcp.txt` (this folder) into the agent's Instructions, Save, Publish.

## 4. Test
In Test your agent, start a new chat:
1. Paste `Summarize this file and build a dashboard`, then the text of `sample-sales.csv`. Pass if the agent calls Live Dashboard and replies with a link and Rows 7.
2. Open the link: Rows 7, Units 67, Revenue 2,090, bar chart by Region, line chart by Date.
3. Ask: "Update that dashboard with this file" and paste `sample-bad.csv`. Pass if the SAME link now shows 3 rows and the warnings on the page's table.
4. Paste only a header line. Pass if the agent reports "file has only a header row".

## 5. Folder to dashboard automatically (optional)
A flow that sends every new file to the server, with no app registration:
1. Power Automate, new **Automated cloud flow**, trigger **SharePoint: When a file is created (properties only)**, pick your site and folder.
2. **SharePoint: Get file content**, using the file identifier.
3. **Condition**: file name ends with `.csv`.
4. Yes branch, **HTTP** action (Premium): Method POST, URI `https://YOUR-HOST/api/upload`, Headers `x-api-key` = your key and `content-type` = `application/json`, Body: `{"name": "<file name>", "csv_text": "<file content as text>"}` built with `base64ToString(...)` of the file content.
5. For Excel files, add an Excel Online "List rows present in a table" and send `rows` instead of `csv_text`: `"rows": <the list of rows>`.
Each new or changed file then updates its dashboard link. The agent can also call `list_dashboards` to hand out the links.

## Alternative: custom connector instead of MCP
`openapi.swagger.yaml` describes the REST endpoint with API-key security. Import it in Power Apps, Custom connectors, Import an OpenAPI file, replace YOUR-HOST, add it to the agent as a tool. Untested.

## Limits
- Files up to 5 MB. CSV text or JSON rows only: Excel and PDF must be converted first (by the flow, or by the agent pasting the cells).
- No sign-in on dashboard links (see Security above). Add Azure/Entra auth later if you need per-user access.
- Data on disk is not encrypted. Do not host sensitive data on a machine you do not control.
