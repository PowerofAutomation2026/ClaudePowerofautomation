// Lab for the zero-touch installer: fake `az` + mock Entra/Dataverse/Copilot Studio.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

let deviceCodes = 0, polls = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = (o, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/devicecode")) { deviceCodes++; polls = 0; return j({ device_code: "dc", message: "Go to https://microsoft.com/devicelogin and enter LAB123", expires_in: 60, interval: 1 }); }
    if (u.pathname.endsWith("/token")) { if (new URLSearchParams(b).get("grant_type") === "refresh_token") return j({ access_token: "tok", refresh_token: "r", expires_in: 3600 }); return ++polls < 2 ? j({ error: "authorization_pending" }, 400) : j({ access_token: "tok", refresh_token: "r", expires_in: 3600 }); }
    if (u.pathname === "/api/data/v9.2/bots") {
      if (req.headers.authorization !== "Bearer dv-token") return j({ error: "auth" }, 401);
      return j({ value: [{ name: "HR Helper", schemaname: "cr_hr" }, { name: "IT Helper", schemaname: "cr_it" }] });
    }
    const m = u.pathname.match(/^\/copilotstudio\/agenticruntime\/3p\/dataverse-backed\/authenticated\/bots\/([^/]+)\/conversations(?:\/([^/]+))?$/);
    if (!m) return j({ error: "nf" }, 404);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(m[2] ? { type: "message", text: `echo(${m[1]}): ${JSON.parse(b).activity.text}` } : { type: "message", text: "hi", conversation: { id: "c1" } })}\n\n`);
  });
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}`;
const root = mkdtempSync(join(tmpdir(), "provlab-"));
const bin = join(root, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "az"), `#!/bin/sh\nexec node ${resolve("test/fake-az.mjs")} "$@"\n`); chmodSync(join(bin, "az"), 0o755);
const ENVS = JSON.stringify([
  { name: "env-other", properties: { displayName: "Sandbox", isDefault: false, linkedEnvironmentMetadata: { instanceApiUrl: url } } },
  { name: "e4c5fd77-2e4c-4cb3-b3a2-1b8b5f7a2b1c", properties: { displayName: "Contoso (default)", isDefault: true, linkedEnvironmentMetadata: { instanceApiUrl: url } } },
]);
async function run(args, o = {}) {
  const home = o.home || mkdtempSync(join(root, "home-"));
  const state = o.state || join(root, `az-${Math.random().toString(36).slice(2)}.json`);
  const ch = spawn("node", [resolve("provision/provision.mjs"), ...args], {
    cwd: o.cwd,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_AZ_STATE: state, FAKE_AZ_ENVS: ENVS, AUTHORITY_URL: url, ENV_URL: url, ...(o.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
  const status = await new Promise((res) => ch.on("exit", res));
  const st = () => JSON.parse(readFileSync(state, "utf8"));
  return { status, home, state, st, out, cfg: join(home, ".config", "Code", "User", "mcp.json") };
}
const pass = (m) => console.log("PASS", m);
const repo = resolve(".");

// 1. fresh zero-touch install
let r = await run(["--yes"]);
assert.equal(r.status, 0, r.out);
let st = r.st();
assert.equal(st.apps.length, 1); assert.equal(st.apps[0].pub, "true"); assert.equal(st.apps[0].redirect, "http://localhost");
assert.deepEqual(st.perms, [{ app: "app-1", api: "8578e004-a5c6-46e7-913e-12f58912df43", perm: "scope-guid-1=Scope" }]); assert.deepEqual(st.consent, ["app-1"]);
pass("creates public-client Entra app, adds CopilotStudio.Copilots.Invoke (looked up dynamically), admin-consents");
const cfg = JSON.parse(readFileSync(r.cfg, "utf8")).servers["copilot-studio-agent"];
assert.equal(cfg.env.ENV_ID, "e4c5fd77-2e4c-4cb3-b3a2-1b8b5f7a2b1c"); assert.equal(cfg.env.CLIENT_ID, "app-1"); assert.equal(cfg.env.TENANT_ID, "tenant-1");
assert.equal(cfg.env.AGENTS, "hr_helper=cr_hr,it_helper=cr_it"); assert.equal(cfg.env.TOKEN_CACHE, "file"); assert.equal(cfg.command, process.execPath);
assert.ok(existsSync(cfg.args[0])); pass("discovers default environment + published agents, installs server, writes VS Code user mcp.json");
assert.match(r.out, /Verified: sign-in works/); assert.ok(r.out.includes("LAB123")); pass("device-code sign-in + connectivity verified during install");

// 2. the VS Code-launched server works with no further sign-in
{
  const before = deviceCodes;
  const ch = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env, HOME: r.home, AUTHORITY_URL: url, ENV_URL: url }, stdio: ["pipe", "pipe", "inherit"] });
  const w = new Map(); let buf = "", id = 0;
  ch.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); w.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; w.set(n, res); ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  await rpc("initialize", {});
  const names = (await rpc("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["ask_hr_helper", "ask_it_helper", "copilot_studio_diagnose"]);
  const a = (await rpc("tools/call", { name: "ask_it_helper", arguments: { message: "ping" } })).result;
  assert.ok(!a.isError && /echo\(cr_it\): ping/.test(a.content[0].text), JSON.stringify(a));
  assert.equal(deviceCodes, before); ch.kill();
  pass("server launched exactly as VS Code would answers via cached token (no second sign-in)");
}

// 3. idempotent re-run reuses the app
const r2 = await run(["--yes"], { home: r.home, state: r.state });
assert.equal(r2.status, 0, r2.out); assert.equal(r2.st().apps.length, 1); assert.match(r2.out, /Found existing app/); pass("idempotent: re-run reuses the app registration");

// 4. existing mcp.json with comments + other servers is preserved and backed up
{
  const home = mkdtempSync(join(root, "home-")); const f = join(home, ".config", "Code", "User", "mcp.json"); mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
  writeFileSync(f, `{\n // my servers\n "servers": { "github": { "type": "http", "url": "https://x/mcp", }, },\n "inputs": [] /* keep */\n}`);
  const x = await run(["--yes", "--no-verify"], { home });
  assert.equal(x.status, 0, x.out);
  const j = JSON.parse(readFileSync(f, "utf8")); assert.ok(j.servers.github && j.servers["copilot-studio-agent"] && Array.isArray(j.inputs)); assert.ok(existsSync(`${f}.bak`));
  pass("merges into existing JSONC mcp.json, keeps other servers, writes .bak");
  // invalid file is never overwritten
  writeFileSync(f, "{ not json");
  const y = await run(["--yes", "--no-verify"], { home }); assert.notEqual(y.status, 0); assert.equal(readFileSync(f, "utf8"), "{ not json"); pass("unparseable mcp.json is left untouched (aborts)");
}

// 5. consent failure is a warning, not a failure
r = await run(["--yes", "--no-verify"], { env: { FAKE_AZ_CONSENT_FAIL: "1" } });
assert.equal(r.status, 0, r.out); assert.match(r.out, /Admin consent not granted/); pass("admin-consent failure degrades to a warning with guidance");

// 6. missing permission scope fails clearly
r = await run(["--yes", "--no-verify"], { env: { FAKE_AZ_NO_SCOPE: "1" } });
assert.notEqual(r.status, 0); assert.match(r.out, /not available in this tenant/); assert.ok(!existsSync(r.cfg)); pass("missing Power Platform API scope fails with a clear message and writes nothing");

// 7. dry run changes nothing
r = await run(["--yes", "--dry-run"]);
assert.equal(r.status, 0, r.out); assert.ok(!existsSync(r.cfg)); assert.equal(r.st().apps.length, 0); assert.match(r.out, /dry-run/); pass("--dry-run makes no changes");

// 8. explicit agent + env, workspace config, reuse client id
{
  const cwd = mkdtempSync(join(root, "ws-"));
  r = await run(["--yes", "--no-verify", "--agent", "mybot=cr_hr", "--env-id", "11111111-2222-3333-4444-555555555555", "--client-id", "my-client", "--workspace", cwd, "--show-reasoning"], { cwd });
  assert.equal(r.status, 0, r.out);
  const e = JSON.parse(readFileSync(join(cwd, ".vscode", "mcp.json"), "utf8")).servers["copilot-studio-agent"].env;
  assert.equal(e.AGENTS, "mybot=cr_hr"); assert.equal(e.CLIENT_ID, "my-client"); assert.equal(e.SHOW_REASONING, "true"); assert.equal(r.st().apps.length, 0);
  assert.ok(!r.st().calls.some((c) => c.startsWith("ad app create"))); pass("explicit --agent/--env-id/--client-id/--workspace skip discovery and app creation");
}

// 9. remove
{
  const home = mkdtempSync(join(root, "home-"));
  const x = await run(["--yes", "--no-verify"], { home });
  const y = await run(["--remove", "--delete-app"], { home, state: x.state });
  assert.equal(y.status, 0, y.out);
  assert.ok(!JSON.parse(readFileSync(x.cfg, "utf8")).servers["copilot-studio-agent"]); assert.ok(!existsSync(join(home, ".copilot-studio-mcp"))); assert.equal(y.st().apps.length, 0);
  pass("--remove --delete-app undoes config, local files and the Entra app");
}
srv.close();
console.log("ALL PROVISIONING LAB TESTS PASSED");
