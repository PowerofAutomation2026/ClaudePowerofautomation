#!/usr/bin/env node
// Minimal stdio MCP server: exposes a Copilot Studio agent (Direct-to-Engine) to VS Code / GitHub Copilot agent mode.
// Config (env): TENANT_ID, CLIENT_ID, ENV_HOST, AGENT_SCHEMA, [AGENT_NAME], [API_VERSION]
import { createInterface } from "node:readline";

const { TENANT_ID, CLIENT_ID, ENV_HOST, AGENT_SCHEMA } = process.env;
const AGENT_NAME = process.env.AGENT_NAME || "copilot_studio_agent";
const API_VERSION = process.env.API_VERSION || "2022-03-01-preview";
const SCOPE = "https://api.powerplatform.com/.default offline_access";
const log = (m) => process.stderr.write(`[copilot-studio-mcp] ${m}\n`);

let token = null; // { access, refresh, exp }
let pending = null; // in-flight device-code sign-in
const conversations = new Map(); // key -> conversationId

const form = (o) => new URLSearchParams(o).toString();
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(body) }).then((r) => r.json());
const authority = () => `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0`;

function store(r) {
  token = { access: r.access_token, refresh: r.refresh_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
}

async function getToken() {
  if (token && token.exp > Date.now()) return token.access;
  if (token?.refresh) {
    const r = await post(`${authority()}/token`, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: token.refresh, scope: SCOPE });
    if (r.access_token) { store(r); return token.access; }
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

async function call(path, body) {
  const t = await getToken();
  const res = await fetch(`https://${ENV_HOST}${path}?api-version=${API_VERSION}`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  const activities = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { activities.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
  }
  if (!activities.length) { try { activities.push(JSON.parse(text)); } catch { /* ignore */ } }
  return activities;
}

const base = () => `/copilotstudio/dataverse-backed/authenticated/bots/${AGENT_SCHEMA}/conversations`;
const messages = (acts) => acts.filter((a) => a.type === "message" && a.text).map((a) => a.text).join("\n\n");

async function ask(message, key = "default") {
  let id = conversations.get(key);
  let intro = "";
  if (!id) {
    const acts = await call(base(), { emitStartConversationEvent: true });
    id = acts.map((a) => a.conversation?.id).find(Boolean);
    if (!id) throw new Error("Could not start conversation");
    conversations.set(key, id);
    intro = messages(acts);
  }
  const acts = await call(`${base()}/${id}`, { activity: { type: "message", text: message, conversation: { id } } });
  return [intro, messages(acts)].filter(Boolean).join("\n\n") || "(agent returned no text)";
}

const tools = [{
  name: `ask_${AGENT_NAME}`,
  description: `Send a message to the Copilot Studio agent "${AGENT_SCHEMA}" and return its reply. Conversation context is kept between calls unless reset is true.`,
  inputSchema: { type: "object", properties: { message: { type: "string" }, reset: { type: "boolean", description: "Start a new conversation" } }, required: ["message"] },
}];

async function handle(req) {
  switch (req.method) {
    case "initialize":
      return { protocolVersion: req.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "copilot-studio-mcp", version: "0.1.0" } };
    case "tools/list": return { tools };
    case "tools/call": {
      const { message, reset } = req.params.arguments || {};
      try {
        if (reset) conversations.clear();
        return { content: [{ type: "text", text: await ask(message) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
      }
    }
    case "ping": return {};
    default: return undefined;
  }
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (process.argv.includes("--selftest")) { /* no env needed */ } else {
  for (const k of ["TENANT_ID", "CLIENT_ID", "ENV_HOST", "AGENT_SCHEMA"]) if (!process.env[k]) { log(`Missing env ${k}`); process.exit(1); }
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification
  try {
    const result = await handle(req);
    if (result === undefined) send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
    else send({ jsonrpc: "2.0", id: req.id, result });
  } catch (e) { send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(e.message || e) } }); }
});
