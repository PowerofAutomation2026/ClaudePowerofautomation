#!/usr/bin/env node
// Stdio MCP server: use Copilot Studio agents (GitHub Copilot harness or Standard harness) from VS Code / GitHub Copilot agent mode.
//
// Env:
//   TENANT_ID, CLIENT_ID            Entra app (public client, delegated CopilotStudio.Copilots.Invoke)
//   ENV_HOST | ENV_ID               environment API host, or the environment GUID (host is derived)
//   AGENT_SCHEMA | AGENTS           one schema name, or "alias=schema,alias2=schema2" for several agents
//   AGENT_NAME                      tool alias when a single agent is configured
//   HARNESS                         auto (default) | github | standard
//   SHOW_REASONING, SHOW_TOOLCALLS  "true" to include the agent's thoughts / tool calls in replies
//   TOKEN_CACHE                     memory (default) | file  (file keeps a refresh token in ~/.copilot-studio-mcp, mode 0600)
//   API_VERSION                     override the api-version for both harnesses
//   AUTHORITY_URL, ENV_URL          endpoint overrides (used by the lab test)
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const env = process.env;
const { TENANT_ID, CLIENT_ID } = env;
const SCOPE = "https://api.powerplatform.com/.default offline_access";
const flag = (k) => /^(1|true|yes)$/i.test(env[k] || "");
const SHOW_REASONING = flag("SHOW_REASONING");
const SHOW_TOOLCALLS = flag("SHOW_TOOLCALLS");
const log = (m) => process.stderr.write(`[copilot-studio-mcp] ${m}\n`);

// environment GUID -> "{first 30 hex}.{last 2 hex}.environment.api.powerplatform.com"
export function hostFromEnvId(id) {
  const h = id.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, -2)}.${h.slice(-2)}.environment.api.powerplatform.com`;
}
const ENV_HOST = env.ENV_HOST || (env.ENV_ID ? hostFromEnvId(env.ENV_ID) : "");
const envUrl = () => env.ENV_URL || `https://${ENV_HOST}`;

const HARNESSES = {
  github: { label: "GitHub Copilot harness", base: (s) => `/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots/${s}/conversations`, ver: "1" },
  standard: { label: "Standard harness", base: (s) => `/copilotstudio/dataverse-backed/authenticated/bots/${s}/conversations`, ver: "2022-03-01-preview" },
};

// ---------- agents ----------
const safe = (s) => s.replace(/[^A-Za-z0-9_]/g, "_");
function parseAgents() {
  const list = (env.AGENTS || env.AGENT_SCHEMA || "").split(",").map((s) => s.trim()).filter(Boolean);
  const single = list.length === 1 && !list[0].includes("=");
  return list.map((e) => {
    const [a, b] = e.includes("=") ? e.split("=") : [null, e];
    return { schema: b.trim(), alias: safe(a?.trim() || (single && env.AGENT_NAME) || b.trim()), harness: null, conv: null, queue: Promise.resolve() };
  });
}
const agents = parseAgents();

// ---------- auth ----------
let token = null; // { access, refresh, exp }
let pending = null;
const cacheFile = () => join(homedir(), ".copilot-studio-mcp", `${safe(CLIENT_ID || "x")}-${safe(TENANT_ID || "x")}.json`);
function loadCache() {
  if (env.TOKEN_CACHE !== "file") return;
  try { const r = JSON.parse(readFileSync(cacheFile(), "utf8")); if (r.refresh) token = { refresh: r.refresh, exp: 0 }; } catch { /* none */ }
}
function saveCache() {
  if (env.TOKEN_CACHE !== "file" || !token?.refresh) return;
  try {
    mkdirSync(join(homedir(), ".copilot-studio-mcp"), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile(), JSON.stringify({ refresh: token.refresh }), { mode: 0o600 });
    chmodSync(cacheFile(), 0o600);
  } catch (e) { log(`token cache not saved: ${e.message}`); }
}
const form = (o) => new URLSearchParams(o).toString();
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(body) }).then((r) => r.json());
const authority = () => `${env.AUTHORITY_URL || "https://login.microsoftonline.com"}/${TENANT_ID}/oauth2/v2.0`;
function store(r) { token = { access: r.access_token, refresh: r.refresh_token || token?.refresh, exp: Date.now() + (r.expires_in - 60) * 1000 }; saveCache(); }

async function getToken() {
  if (token?.access && token.exp > Date.now()) return token.access;
  if (token?.refresh) {
    const r = await post(`${authority()}/token`, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: token.refresh, scope: SCOPE });
    if (r.access_token) { store(r); return token.access; }
    token = null;
  }
  if (!pending) {
    const dc = await post(`${authority()}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE });
    if (!dc.device_code) throw new Error(`Sign-in failed: ${dc.error_description || JSON.stringify(dc)}`);
    log(dc.message);
    pending = { message: dc.message };
    (async () => {
      const end = Date.now() + dc.expires_in * 1000;
      while (Date.now() < end) {
        await new Promise((s) => setTimeout(s, (dc.interval || 5) * 1000));
        const r = await post(`${authority()}/token`, { client_id: CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code });
        if (r.access_token) { store(r); break; }
        if (r.error && r.error !== "authorization_pending" && r.error !== "slow_down") break;
      }
      pending = null;
    })();
  }
  throw new Error(`NEEDS_SIGNIN: ${pending.message} Then ask again.`);
}

// ---------- transport ----------
class HttpError extends Error {
  constructor(status, body, harness) { super(`${status}: ${body.slice(0, 300)}`); this.status = status; this.harness = harness; }
}
const HINTS = {
  401: "Token rejected. Check the app has the delegated Power Platform API permission CopilotStudio.Copilots.Invoke (not just .Test), consent was granted, and the GitHub Copilot harness preview is enabled.",
  403: "Forbidden. The agent must be published, set to 'Authenticate with Microsoft', and shared with your user; also check consent and DLP/policy.",
  404: "Not found. Check the environment (host/ID), the case-sensitive agent schema name, that the agent is published, and that this harness route is enabled for the environment.",
};
const hint = (e) => (e instanceof HttpError && HINTS[e.status] ? `\nHint: ${HINTS[e.status]}` : "");

// POST and read the SSE (or JSON) response incrementally; onActivity fires for each activity as it arrives.
async function call(h, path, body, onActivity) {
  const t = await getToken();
  const ver = env.API_VERSION || h.ver;
  const res = await fetch(`${envUrl()}${path}?api-version=${ver}`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text(), h);
  const acts = [];
  const push = (a) => { acts.push(a); onActivity?.(a); };
  let buf = "", raw = "";
  const feed = (line) => { if (line.startsWith("data:")) { try { push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ } } };
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    const s = dec.decode(chunk, { stream: true });
    raw += s; buf += s;
    let i; while ((i = buf.indexOf("\n")) >= 0) { feed(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
  }
  feed(buf.replace(/\r$/, ""));
  if (!acts.length) { try { const j = JSON.parse(raw); (Array.isArray(j) ? j : [j]).forEach(push); } catch { /* ignore */ } }
  return { acts, convId: res.headers.get("x-ms-conversationid") };
}

// ---------- activity rendering ----------
function cardText(card) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "TextBlock" && n.text) out.push(n.text);
    if (n.type === "Action.Submit" || n.type === "Action.OpenUrl") out.push(`[action: ${n.title || n.type}${n.url ? ` -> ${n.url}` : ""}]`);
    for (const k of ["body", "actions", "items", "columns", "facts"]) if (Array.isArray(n[k])) n[k].forEach(walk);
  };
  walk(card);
  return out.join("\n");
}
function collect() {
  const s = { replies: [], thoughts: [], tools: new Map(), suggested: [], cards: [] };
  return {
    s,
    add(a) {
      for (const e of a.entities || []) {
        if (e.type === "thought" && e.text) s.thoughts.push(e.text);
        if (e.type === "toolCall") {
          const id = e.toolCallId || e.id || `t${s.tools.size}`;
          s.tools.set(id, { ...(s.tools.get(id) || {}), ...e });
        }
      }
      if (a.type !== "message") return;
      if (a.text) s.replies.push(a.text);
      for (const act of a.suggestedActions?.actions || []) s.suggested.push(act.title || act.text || act.value);
      for (const at of a.attachments || []) if (/card\.adaptive|adaptivecard/i.test(at.contentType || "") && at.content) s.cards.push(cardText(at.content));
    },
  };
}
function render(s) {
  const parts = [];
  if (SHOW_REASONING && s.thoughts.length) parts.push("Reasoning:\n" + s.thoughts.map((t) => `- ${t}`).join("\n"));
  if (SHOW_TOOLCALLS && s.tools.size) parts.push("Tool calls:\n" + [...s.tools.values()].map((t) => `- ${t.name || t.toolName || t.title || "tool"}: ${t.status || t.state || "called"}`).join("\n"));
  if (s.replies.length) parts.push(s.replies.join("\n\n"));
  for (const c of s.cards.filter(Boolean)) parts.push(c);
  const sug = s.suggested.filter(Boolean);
  if (sug.length) parts.push("Suggested replies: " + sug.map((x) => `"${x}"`).join(", "));
  return parts.join("\n\n");
}

// ---------- conversation ----------
const order = (a) => (a.harness ? [a.harness] : (env.HARNESS || "auto") === "auto" ? ["github", "standard"] : [env.HARNESS === "standard" ? "standard" : "github"]);

async function startConversation(a, c) {
  let lastErr;
  for (const name of order(a)) {
    const h = HARNESSES[name];
    try {
      const { acts, convId } = await call(h, h.base(a.schema), { emitStartConversationEvent: true }, (x) => c.add(x));
      const id = acts.map((x) => x.conversation?.id).find(Boolean) || convId;
      if (!id) throw new Error("Could not start conversation (no conversation id returned)");
      a.harness = name; a.conv = id;
      return h;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof HttpError && e.status === 404 && (env.HARNESS || "auto") === "auto")) throw e;
    }
  }
  throw lastErr;
}

function ask(a, message, progress, reset) {
  const run = async () => {
    if (reset) a.conv = null;
    const c = collect();
    let h = a.harness && HARNESSES[a.harness];
    if (!a.conv) h = await startConversation(a, c);
    const onAct = (x) => {
      c.add(x);
      if (x.type === "typing" && x.text && progress) progress(x.text);
    };
    await call(h, `${h.base(a.schema)}/${a.conv}`, { activity: { type: "message", text: message, conversation: { id: a.conv } } }, onAct);
    return render(c.s) || "(agent returned no text)";
  };
  const p = a.queue.then(run, run); // one turn at a time per agent
  a.queue = p.catch(() => {});
  return p;
}

async function diagnose() {
  const lines = [`Environment: ${ENV_HOST || env.ENV_URL || "(missing)"}`, `Harness setting: ${env.HARNESS || "auto"}`];
  try { await getToken(); lines.push("Sign-in: OK"); } catch (e) { return [...lines, `Sign-in: ${e.message}`].join("\n"); }
  for (const a of agents) {
    const c = collect();
    try { const h = await startConversation(a, c); lines.push(`${a.schema}: OK via ${h.label}`); }
    catch (e) { lines.push(`${a.schema}: FAILED ${e.message}${hint(e)}`); }
  }
  return lines.join("\n");
}

// ---------- MCP ----------
const tools = [
  ...agents.map((a) => ({
    name: `ask_${a.alias}`,
    description: `Send a message to the Copilot Studio agent "${a.schema}" and return its reply. Context is kept between calls unless reset is true.`,
    inputSchema: { type: "object", properties: { message: { type: "string" }, reset: { type: "boolean", description: "Start a new conversation" } }, required: ["message"] },
  })),
  { name: "copilot_studio_diagnose", description: "Check sign-in and connectivity to each configured Copilot Studio agent and explain failures.", inputSchema: { type: "object", properties: {} } },
];
const prompts = agents.map((a) => ({ name: `ask_${a.alias}`, description: `Ask the "${a.schema}" Copilot Studio agent`, arguments: [{ name: "question", required: true }] }));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function handle(req) {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: req.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "copilot-studio-mcp", version: "0.2.0" },
        instructions: `Talks to Copilot Studio agents (${agents.map((a) => a.schema).join(", ")}). Use ask_* tools; copilot_studio_diagnose explains connection problems.`,
      };
    case "tools/list": return { tools };
    case "prompts/list": return { prompts };
    case "prompts/get": {
      const q = req.params?.arguments?.question || "";
      return { messages: [{ role: "user", content: { type: "text", text: `Use the ${req.params.name} tool to ask: ${q}` } }] };
    }
    case "tools/call": {
      const { name, arguments: args = {} } = req.params;
      try {
        if (name === "copilot_studio_diagnose") return { content: [{ type: "text", text: await diagnose() }] };
        const a = agents.find((x) => `ask_${x.alias}` === name);
        if (!a) return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
        const pt = req.params._meta?.progressToken;
        let n = 0;
        const progress = pt === undefined ? null : (text) => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: pt, progress: ++n, message: text.slice(-500) } });
        return { content: [{ type: "text", text: await ask(a, args.message, progress, args.reset) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `${e.message || e}${hint(e)}` }] };
      }
    }
    case "ping": return {};
    default: return undefined;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const k of ["TENANT_ID", "CLIENT_ID"]) if (!env[k]) { log(`Missing env ${k}`); process.exit(1); }
  if (!ENV_HOST && !env.ENV_URL) { log("Missing ENV_HOST or ENV_ID"); process.exit(1); }
  if (!agents.length) { log("Missing AGENT_SCHEMA or AGENTS"); process.exit(1); }
  loadCache();
  if (process.argv.includes("--diagnose")) {
    // CLI mode used by the installer: sign in (device code, waits), cache the refresh token, then check every agent.
    const stop = Date.now() + 5 * 60 * 1000;
    for (;;) {
      try { await getToken(); break; } catch (e) {
        if (!/NEEDS_SIGNIN/.test(e.message) || Date.now() > stop) { console.log(`Sign-in: ${e.message}`); process.exit(1); }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const text = await diagnose();
    console.log(text);
    process.exit(/FAILED|Sign-in:(?! OK)/.test(text) ? 1 : 0);
  }
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let req; try { req = JSON.parse(line); } catch { return; }
    if (req.id === undefined) return;
    try {
      const result = await handle(req);
      send(result === undefined ? { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id: req.id, result });
    } catch (e) { send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(e.message || e) } }); }
  });
}
