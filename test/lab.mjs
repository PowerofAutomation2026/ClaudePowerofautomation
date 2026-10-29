// Lab: mock Entra + mock Copilot Studio, drives the real MCP server over stdio.
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

let signedIn = false, polls = 0, convs = 0, authHeaders = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = (o, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith("/devicecode")) return j({ device_code: "dc", message: "Go to https://microsoft.com/devicelogin and enter ABC123", expires_in: 60, interval: 1 });
    if (req.url.endsWith("/token")) {
      const p = new URLSearchParams(b);
      if (p.get("grant_type") === "refresh_token") return j({ access_token: "tok2", refresh_token: "r", expires_in: 3600 });
      if (++polls < 2) return j({ error: "authorization_pending" }, 400);
      signedIn = true; return j({ access_token: "tok1", refresh_token: "r", expires_in: 3600 });
    }
    authHeaders.push(req.headers.authorization);
    const base = "/copilotstudio/dataverse-backed/authenticated/bots/cr_test/conversations";
    const sse = (acts) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(acts.map((a) => `event: activity\ndata: ${JSON.stringify(a)}\n\n`).join("")); };
    if (req.url.startsWith(base + "?")) { convs++; return sse([{ type: "message", text: "Hi, I'm the lab agent.", conversation: { id: "conv-1" } }]); }
    if (req.url.startsWith(base + "/conv-1?")) { const t = JSON.parse(b).activity.text; return sse([{ type: "typing" }, { type: "message", text: `echo: ${t}` }]); }
    j({ error: "not found", url: req.url }, 404);
  });
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}`;
const child = spawn("node", ["mcp/copilot-studio-mcp.mjs"], {
  env: { ...process.env, TENANT_ID: "t", CLIENT_ID: "c", ENV_HOST: "h", AGENT_SCHEMA: "cr_test", AGENT_NAME: "spx_agent", AUTHORITY_URL: url, ENV_URL: url },
  stdio: ["pipe", "pipe", "inherit"],
});
const waiters = new Map(); let buf = "";
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
let id = 0;
const rpc = (method, params) => new Promise((r) => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const callTool = (message, extra = {}) => rpc("tools/call", { name: "ask_spx_agent", arguments: { message, ...extra } }).then((m) => m.result);

const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
assert.equal(init.result.serverInfo.name, "copilot-studio-mcp");
const list = await rpc("tools/list");
assert.equal(list.result.tools[0].name, "ask_spx_agent"); console.log("PASS initialize + tools/list");

let r = await callTool("hello");
assert.ok(r.isError && r.content[0].text.includes("NEEDS_SIGNIN") && r.content[0].text.includes("ABC123")); console.log("PASS first call prompts device-code sign-in");
await new Promise((s) => setTimeout(s, 3500));
r = await callTool("hello");
assert.ok(!r.isError, JSON.stringify(r)); assert.match(r.content[0].text, /lab agent/); assert.match(r.content[0].text, /echo: hello/); console.log("PASS after sign-in: conversation started + reply:", JSON.stringify(r.content[0].text));
r = await callTool("again");
assert.equal(r.content[0].text, "echo: again"); assert.equal(convs, 1); console.log("PASS conversation reused (1 start, context kept)");
r = await callTool("fresh", { reset: true });
assert.equal(convs, 2); console.log("PASS reset starts a new conversation");
assert.ok(authHeaders.every((h) => h === "Bearer tok1")); console.log("PASS bearer token sent on every agent call");
child.kill(); srv.close();
console.log("ALL LAB TESTS PASSED");
