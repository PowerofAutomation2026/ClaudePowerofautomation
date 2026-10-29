// Lab: mock Entra + mock Copilot Studio (GitHub Copilot harness + Standard harness) driving the real MCP server over stdio.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const GH = "/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots";
const STD = "/copilotstudio/dataverse-backed/authenticated/bots";
let polls = 0, deviceCodes = 0, refreshes = 0;
const log = []; // {path, ver, auth}
const sse = (res, acts, delay = 0, headers = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  let i = 0;
  const next = () => { if (i >= acts.length) return res.end(); res.write(`event: activity\ndata: ${JSON.stringify(acts[i++])}\n\n`); delay ? setTimeout(next, delay) : next(); };
  next();
};
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = (o, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/devicecode")) { deviceCodes++; return j({ device_code: "dc", message: "Go to https://microsoft.com/devicelogin and enter ABC123", expires_in: 60, interval: 1 }); }
    if (u.pathname.endsWith("/token")) {
      if (new URLSearchParams(b).get("grant_type") === "refresh_token") { refreshes++; return j({ access_token: "tok2", refresh_token: "r", expires_in: 3600 }); }
      if (++polls < 2) return j({ error: "authorization_pending" }, 400);
      return j({ access_token: "tok1", refresh_token: "r", expires_in: 3600 });
    }
    const m = u.pathname.match(/^(.*\/bots)\/([^/]+)\/conversations(?:\/([^/]+))?$/);
    if (!m) return j({ error: "nf" }, 404);
    const [, root, bot, conv] = m;
    log.push({ root, bot, conv, ver: u.searchParams.get("api-version"), auth: req.headers.authorization });
    if (bot === "cr_forbidden") return j({ error: "no" }, 403);
    if (root === GH && bot === "cr_std") return j({ error: "nf" }, 404); // std agent not on GH harness
    if (root === STD && bot === "cr_gh") return j({ error: "nf" }, 404);
    if (!conv) {
      if (bot === "cr_hdr") return sse(res, [{ type: "message", text: "hdr hi" }], 0, { "x-ms-conversationid": "conv-hdr" });
      return sse(res, [{ type: "message", text: `Hi from ${bot}`, conversation: { id: `conv-${bot}` } }]);
    }
    const t = JSON.parse(b).activity.text;
    if (t === "think") return sse(res, [
      { type: "typing", text: "Let me" }, { type: "typing", text: "Let me check" },
      { type: "typing", entities: [{ type: "thought", text: "Need to look up the order" }] },
      { type: "typing", entities: [{ type: "toolCall", toolCallId: "1", name: "LookupOrder", status: "started" }] },
      { type: "typing", entities: [{ type: "toolCall", toolCallId: "1", name: "LookupOrder", status: "finished" }] },
      { type: "message", text: "Order shipped.", suggestedActions: { actions: [{ title: "Track it" }, { title: "Cancel" }] },
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", body: [{ type: "TextBlock", text: "Order #42" }], actions: [{ type: "Action.Submit", title: "Open" }] } }] },
    ], 150);
    return sse(res, [{ type: "typing" }, { type: "message", text: `echo(${bot}): ${t}` }]);
  });
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}`;

function start(extra = {}, home = mkdtempSync(join(tmpdir(), "csmcp-"))) {
  const child = spawn("node", ["mcp/copilot-studio-mcp.mjs"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TENANT_ID: "t", CLIENT_ID: "c", ENV_ID: "e4c5fd77-2e4c-4cb3-b3a2-1b8b5f7a2b1c", AUTHORITY_URL: url, ENV_URL: url, ...extra },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiters = new Map(), notes = []; let buf = "", id = 0;
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) notes.push(m); else waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const tool = (name, args, meta) => rpc("tools/call", { name, arguments: args, _meta: meta }).then((m) => m.result);
  return { child, rpc, tool, notes, home };
}
const pass = (m) => console.log("PASS", m);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// --- env host derivation
{
  const { hostFromEnvId } = await import("../mcp/copilot-studio-mcp.mjs");
  assert.equal(hostFromEnvId("00000000-0000-0000-0000-0000000000AB"), "0".repeat(30) + ".ab.environment.api.powerplatform.com");
  assert.equal(hostFromEnvId("e4c5fd77-2e4c-4cb3-b3a2-1b8b5f7a2b1c").split(".")[1], "1c");
  pass("environment GUID -> 30/2 API host");
}

// --- main scenario: two agents, auto harness, reasoning + tool calls on
const home = mkdtempSync(join(tmpdir(), "csmcp-"));
let s = start({ AGENTS: "gh=cr_gh,std=cr_std,hdr=cr_hdr,forbid=cr_forbidden", SHOW_REASONING: "true", SHOW_TOOLCALLS: "true", TOKEN_CACHE: "file" }, home);
const init = await s.rpc("initialize", { protocolVersion: "2025-03-26" });
assert.equal(init.result.serverInfo.name, "copilot-studio-mcp"); assert.ok(init.result.instructions.includes("cr_gh"));
const names = (await s.rpc("tools/list")).result.tools.map((t) => t.name);
assert.deepEqual(names, ["ask_gh", "ask_std", "ask_hdr", "ask_forbid", "copilot_studio_diagnose"]); pass("multi-agent: one tool per agent + diagnose");
const pl = (await s.rpc("prompts/list")).result.prompts; assert.equal(pl.length, 4); pass("prompts/list exposes slash-command prompts");

let r = await s.tool("ask_gh", { message: "hello" });
assert.ok(r.isError && r.content[0].text.includes("ABC123")); pass("first call prompts device-code sign-in");
await sleep(3500);

r = await s.tool("ask_gh", { message: "hello" });
assert.ok(!r.isError, JSON.stringify(r)); assert.match(r.content[0].text, /Hi from cr_gh[\s\S]*echo\(cr_gh\): hello/);
assert.ok(log.some((l) => l.root === GH && l.bot === "cr_gh" && l.ver === "1")); pass("GitHub Copilot harness route (/agenticruntime/3p, api-version=1) used");

r = await s.tool("ask_std", { message: "hi" });
assert.match(r.content[0].text, /echo\(cr_std\): hi/);
assert.ok(log.some((l) => l.root === GH && l.bot === "cr_std") && log.some((l) => l.root === STD && l.bot === "cr_std" && l.ver === "2022-03-01-preview")); pass("auto harness: 404 on GitHub route falls back to Standard route");
r = await s.tool("ask_std", { message: "again" });
assert.equal(log.filter((l) => l.root === GH && l.bot === "cr_std").length, 1); pass("harness choice remembered (no repeat probing)");

r = await s.tool("ask_hdr", { message: "x" });
assert.match(r.content[0].text, /echo\(cr_hdr\)/); assert.ok(log.some((l) => l.conv === "conv-hdr")); pass("conversation id taken from x-ms-conversationid header when body lacks it");

const t0 = Date.now();
r = await s.tool("ask_gh", { message: "think" }, { progressToken: "p1" });
const txt = r.content[0].text;
assert.match(txt, /Reasoning:\n- Need to look up the order/); assert.match(txt, /Tool calls:\n- LookupOrder: finished/); assert.match(txt, /Order shipped\./);
assert.match(txt, /Order #42/); assert.match(txt, /\[action: Open\]/); assert.match(txt, /Suggested replies: "Track it", "Cancel"/);
pass("reasoning, tool calls (deduped by id, final status), adaptive card text and suggested replies rendered");
const prog = s.notes.filter((n) => n.method === "notifications/progress");
assert.ok(prog.length >= 2 && prog[0].params.progressToken === "p1" && prog.at(-1).params.message === "Let me check"); pass("streaming: typing snapshots forwarded as MCP progress notifications");

const [a, b] = await Promise.all([s.tool("ask_gh", { message: "one" }), s.tool("ask_gh", { message: "two" })]);
assert.match(a.content[0].text, /one/); assert.match(b.content[0].text, /two/); pass("concurrent sends to one agent are serialized");

const before = log.filter((l) => l.bot === "cr_gh" && !l.conv).length;
await s.tool("ask_gh", { message: "fresh", reset: true });
assert.equal(log.filter((l) => l.bot === "cr_gh" && !l.conv).length, before + 1); pass("reset starts a new conversation");

r = await s.tool("ask_forbid", { message: "x" });
assert.ok(r.isError && /403/.test(r.content[0].text) && /shared with your user/.test(r.content[0].text)); pass("403 returns an actionable hint");

r = await s.tool("copilot_studio_diagnose", {});
assert.match(r.content[0].text, /Sign-in: OK/); assert.match(r.content[0].text, /cr_gh: OK via GitHub Copilot harness/); assert.match(r.content[0].text, /cr_std: OK via Standard harness/); assert.match(r.content[0].text, /cr_forbidden: FAILED[\s\S]*Hint/); pass("diagnose reports sign-in and per-agent harness/failures");
assert.ok(log.every((l) => /^Bearer tok[12]$/.test(l.auth))); pass("bearer token on every agent call");

const cf = join(home, ".copilot-studio-mcp", "c-t.json");
assert.equal(JSON.parse(readFileSync(cf, "utf8")).refresh, "r"); assert.equal(statSync(cf).mode & 0o777, 0o600); pass("TOKEN_CACHE=file saves refresh token with mode 0600");
s.child.kill();

// --- restart: no new device code, uses cached refresh token
const dcBefore = deviceCodes;
s = start({ AGENT_SCHEMA: "cr_gh", AGENT_NAME: "solo", TOKEN_CACHE: "file" }, home);
await s.rpc("initialize", {});
assert.equal((await s.rpc("tools/list")).result.tools[0].name, "ask_solo");
r = await s.tool("ask_solo", { message: "after restart" });
assert.ok(!r.isError && /echo\(cr_gh\): after restart/.test(r.content[0].text)); assert.equal(deviceCodes, dcBefore); assert.ok(refreshes >= 1); pass("restart: silent sign-in from cached refresh token; AGENT_NAME alias for a single agent");
s.child.kill();

// --- reasoning off by default
s = start({ AGENT_SCHEMA: "cr_gh", AGENT_NAME: "solo", TOKEN_CACHE: "file" }, home);
await s.rpc("initialize", {});
r = await s.tool("ask_solo", { message: "think" });
assert.ok(!/Reasoning:|Tool calls:/.test(r.content[0].text) && /Order shipped/.test(r.content[0].text)); pass("reasoning/tool calls hidden unless enabled");
s.child.kill(); srv.close();
console.log("ALL LAB TESTS PASSED");
