const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Swagger 2.0 for a Power Platform custom connector that fronts this MCP server (Copilot Studio imports it as a tool). */
export function connectorSwagger(base) {
  const u = new URL(base);
  return {
    swagger: '2.0',
    info: { title: 'Live Dashboard MCP', description: 'Build and update live dashboards, optionally bound to Excel, CSV, SQL Server and Oracle data.', version: '1.0.0' },
    host: u.host, basePath: '/', schemes: [u.protocol.replace(':', '')],
    consumes: ['application/json'], produces: ['application/json'],
    paths: { '/mcp': { post: {
      summary: 'Live Dashboard MCP', description: 'Streamable HTTP MCP endpoint', operationId: 'InvokeServer',
      'x-ms-agentic-protocol': 'mcp-streamable-1.0',
      responses: { 200: { description: 'Success' }, 401: { description: 'Unauthorized' } },
    } } },
    securityDefinitions: { api_key: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    security: [{ api_key: [] }],
  };
}

export const connectorProperties = () => ({
  properties: {
    connectionParameters: { api_key: { type: 'securestring', uiDefinition: {
      displayName: 'Server key', description: 'The API_KEY of the Live Dashboard MCP server', tooltip: 'Printed at the end of deployment',
      constraints: { tabIndex: 2, clearText: false, required: 'true' } } } },
    iconBrandColor: '#2563eb', capabilities: [], publisher: 'Live Dashboard MCP', stackOwner: 'Live Dashboard MCP',
  },
});

export const agentInstructions = () => `You can build and update live dashboards with the "Live Dashboard MCP" tools.

How to work
1. If the user wants data from a connected source, call list_datasources first. For SQL Server / Oracle sources with table discovery, call list_tables, then describe_table to see the real column names and sample rows. For CSV / Excel or named queries, call describe_datasource.
2. Create the dashboard with create_dashboard, then add widgets with bind_widget (live, auto-refreshing, numbers are computed by the server so they are exact). Use build_dashboard only for small static data the user gave you in chat.
3. Typical layout: 3-4 kpi widgets on top (set warn_at / critical_at when the user mentions limits), then line charts for trends, bar charts for comparisons, a pie only for shares of a whole (max 6 slices), and a table for detail. Keep titles short.
4. Always finish by giving the user the full dashboard url returned by the tools. Never invent a url. Tell them it refreshes by itself while open.
5. To change a dashboard later, reuse its dashboard_id and widget_id (list_dashboards / get_dashboard) instead of creating a new one. rotate_link replaces a link that was shared by mistake.

Rules
- Never guess numbers. Use only data from the user or from the data sources.
- You cannot write SQL. Pick tables, columns, aggregations and filters; the server builds the query.
- If a tool returns an error, read the message (it lists valid columns / sources) and retry once with the fix before asking the user.
`;

export function setupPage(base, { oauth }) {
  const pre = (id, text) => `<div class="code"><pre id="${id}">${esc(text)}</pre><button onclick="navigator.clipboard.writeText(document.getElementById('${id}').innerText);this.textContent='Copied'">Copy</button></div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Dashboard MCP: setup</title>
<style>:root{color-scheme:light dark;--l:#d0d5dd;--m:#667085}body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:820px;margin:32px auto;padding:0 18px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px}.sub{color:var(--m);margin:0 0 18px}.card{border:1px solid var(--l);border-radius:10px;padding:14px 18px;margin:10px 0}
.code{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--l);border-radius:8px;padding:8px 10px;margin:8px 0;background:rgba(127,127,127,.07)}.code pre{margin:0;flex:1;white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,Menlo,Consolas,monospace}
button{font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--l);border-radius:6px;background:transparent;color:inherit;cursor:pointer}a{color:#2563eb}.tag{font-size:12px;background:rgba(37,99,235,.12);color:#2563eb;border-radius:20px;padding:1px 9px;margin-left:6px}ol{padding-left:20px}</style>
<h1>Live Dashboard MCP</h1><p class="sub">Add this server to a Copilot Studio agent so it can build live dashboards. Server is up.</p>
<h2>1. Your MCP URL</h2>${pre('u', `${base}/mcp`)}
<h2>2. Add it to your agent</h2>
${oauth ? `<div class="card"><b>Option A: sign in (OAuth dynamic discovery)</b><span class="tag">easiest</span><ol>
<li>Copilot Studio → your agent → <b>Tools</b> → <b>Add a tool</b> → <b>New tool</b> → <b>Model Context Protocol</b>.</li>
<li>Paste the URL above. Authentication: <b>OAuth 2.0</b> → <b>Dynamic discovery</b>. Create.</li>
<li>When asked to sign in, a page from this server opens: enter the <b>server key</b> and press Allow. No Azure app registration needed.</li></ol></div>` : ''}
<div class="card"><b>Option B: API key</b><ol>
<li>Same wizard, Authentication: <b>API key</b>, location <b>Header</b>, header name <code>x-api-key</code>.</li>
<li>Create the connection and paste the server key as the value.</li></ol></div>
<div class="card"><b>Option C: custom connector</b> (what the deploy script does for you)<ol>
<li>Download <a href="/copilot-studio/connector.swagger.json">connector.swagger.json</a> and <a href="/copilot-studio/connector.properties.json">connector.properties.json</a>.</li>
<li>Power Apps → Custom connectors → Import an OpenAPI file, or run <code>pac connector create --api-definition-file connector.swagger.json --api-properties-file connector.properties.json</code>.</li>
<li>In Copilot Studio add the connector as a tool and create the connection with the server key.</li></ol></div>
<h2>3. Select a Claude model and paste these instructions</h2>
<p class="sub">Set the agent's model to Claude (if your tenant has Anthropic models enabled). Claude designs the dashboard; this server draws it. <a href="/copilot-studio/agent-instructions.md">Open as text</a></p>
${pre('i', agentInstructions())}
<p class="sub">Health: <a href="/healthz">/healthz</a> · Dashboards you create open at links the tools return.</p></html>`;
}
