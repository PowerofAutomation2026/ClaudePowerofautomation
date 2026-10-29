#!/usr/bin/env node
// Zero-touch provisioning: Entra app + Power Platform API permission + environment/agent discovery
// + MCP server install + VS Code mcp.json wiring + sign-in/verify.  Needs only Node 18+ and the Azure CLI (`az`).
//
//   node provision.mjs                      interactive (pick environment / agents)
//   node provision.mjs --yes                no prompts: default environment, all published agents
//   node provision.mjs --remove [--delete-app]
// Run with --help for all options.
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PP_API = "8578e004-a5c6-46e7-913e-12f58912df43"; // Power Platform API (override with --pp-api-id)
const SCOPE_NAME = "CopilotStudio.Copilots.Invoke";
const SERVER_NAME = "copilot-studio-agent";

// ---------- args ----------
const A = { agent: [], appName: "Copilot Studio MCP for VS Code", harness: "auto" };
const argv = process.argv.slice(2);
const takes = new Set(["tenant", "env-id", "agent", "app-name", "client-id", "workspace", "config", "harness", "pp-api-id"]);
for (let i = 0; i < argv.length; i++) {
  const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m) { console.error(`Unexpected argument ${argv[i]}`); process.exit(2); }
  const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  let v = true;
  if (m[1] === "workspace") v = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  else if (takes.has(m[1])) v = m[2] ?? argv[++i];
  if (k === "agent") A.agent.push(...String(v).split(",").map((s) => s.trim()).filter(Boolean)); else A[k] = v;
}
if (A.help) {
  console.log(`Options:
  --tenant <id>           Entra tenant (default: the signed-in az tenant)
  --env-id <guid>         Power Platform environment (default: prompt, or your default environment with --yes)
  --agent <schema|alias=schema>   Agent(s); repeatable or comma-separated (default: discover published agents)
  --all-agents            Use every published agent without asking
  --harness auto|github|standard  (default auto)
  --app-name <name>       Entra app display name (default "${A.appName}")
  --client-id <id>        Reuse an existing app registration instead of creating one
  --workspace [dir]       Write <dir>/.vscode/mcp.json (default dir: cwd) instead of the VS Code user config
  --config <file>         Write to an explicit mcp.json
  --insiders              Target VS Code Insiders
  --show-reasoning --show-toolcalls   Include the agent's thoughts / tool calls in replies
  --no-verify             Skip the sign-in + connectivity check
  --yes                   Never prompt
  --dry-run               Show what would change, change nothing
  --remove [--delete-app] Undo: remove the VS Code entry, server copy and token cache (and optionally the Entra app)`);
  process.exit(0);
}
const interactive = !A.yes && !!process.stdin.isTTY;

// ---------- output ----------
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const step = (m) => console.log(`\n${c(36, "==> " + m)}`);
const ok = (m) => console.log(`    ${c(32, m)}`);
const warn = (m) => console.log(`    ${c(33, m)}`);
const die = (m) => { console.error(c(31, `\nERROR: ${m}`)); process.exit(1); };
const dry = (m) => console.log(`    ${c(35, "[dry-run] " + m)}`);

// ---------- helpers ----------
const win = platform() === "win32";
const winQuote = (a) => (/[\s"&|<>^%?]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function az(args, { json = true, allowFail = false, stdio } = {}) {
  const r = win
    ? spawnSync(["az", ...args.map(winQuote)].join(" "), { shell: true, encoding: "utf8", stdio: stdio || "pipe" })
    : spawnSync("az", args, { encoding: "utf8", stdio: stdio || "pipe" });
  if (r.error && r.error.code === "ENOENT") die("Azure CLI (az) not found. Install it (Windows: winget install Microsoft.AzureCLI; macOS: brew install azure-cli) and re-run.");
  if (r.status !== 0) {
    if (allowFail) return null;
    die(`az ${args.slice(0, 3).join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  }
  const out = (r.stdout || "").trim();
  if (!json) return out;
  if (!out) return null;
  try { return JSON.parse(out); } catch { return out; }
}
const ask = (q, def = "") => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => { rl.close(); res(a.trim() || def); });
});
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "agent";

// JSONC (mcp.json allows comments / trailing commas)
function parseJsonc(text) {
  let out = "", i = 0, str = false;
  while (i < text.length) {
    const ch = text[i];
    if (str) { out += ch; if (ch === "\\") out += text[++i]; else if (ch === '"') str = false; i++; continue; }
    if (ch === '"') { str = true; out += ch; i++; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += ch; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const home = homedir();
const stateDir = join(home, ".copilot-studio-mcp");
const serverDest = join(stateDir, "server", "copilot-studio-mcp.mjs");
const stateFile = join(stateDir, "install.json");
function configPath() {
  if (A.config) return resolve(A.config);
  if (A.workspace) return join(resolve(A.workspace === true ? "." : A.workspace), ".vscode", "mcp.json");
  const code = A.insiders ? "Code - Insiders" : "Code";
  if (win) return join(process.env.APPDATA || join(home, "AppData", "Roaming"), code, "User", "mcp.json");
  if (platform() === "darwin") return join(home, "Library", "Application Support", code, "User", "mcp.json");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), code, "User", "mcp.json");
}

// ---------- remove ----------
if (A.remove) {
  step("Removing Copilot Studio MCP");
  let st = {}; try { st = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* none */ }
  const cfg = st.configPath || configPath();
  if (existsSync(cfg)) {
    try {
      const j = parseJsonc(readFileSync(cfg, "utf8"));
      if (j.servers?.[SERVER_NAME]) { delete j.servers[SERVER_NAME]; if (!A.dryRun) { writeFileSync(`${cfg}.bak`, readFileSync(cfg)); writeFileSync(cfg, JSON.stringify(j, null, 2) + "\n"); } ok(`Removed '${SERVER_NAME}' from ${cfg}`); }
      else ok("VS Code config had no entry");
    } catch (e) { warn(`Could not edit ${cfg}: ${e.message}`); }
  }
  if (!A.dryRun) rmSync(stateDir, { recursive: true, force: true });
  ok(`Deleted ${stateDir} (server copy, token cache)`);
  if (A.deleteApp && (st.clientId || A.clientId)) {
    if (A.dryRun) dry("would delete Entra app"); else { az(["ad", "app", "delete", "--id", st.clientId || A.clientId], { json: false, allowFail: true }); ok("Deleted Entra app registration"); }
  } else if (st.clientId) warn(`Entra app ${st.clientId} kept (use --delete-app to remove it)`);
  process.exit(0);
}

// ---------- 1. prerequisites ----------
step("Checking prerequisites");
if (Number(process.versions.node.split(".")[0]) < 18) die(`Node 18+ required (found ${process.version}).`);
ok(`Node ${process.version}`);
const ver = az(["--version"], { json: false, allowFail: true });
if (ver === null) die("Azure CLI (az) not found. Install it (Windows: winget install Microsoft.AzureCLI; macOS: brew install azure-cli) and re-run.");
ok("Azure CLI present");

// ---------- 2. sign in ----------
step("Azure sign-in");
let account = az(["account", "show", "-o", "json"], { allowFail: true });
if (!account) {
  if (A.dryRun) dry("would run: az login"); else {
    az(["login", ...(A.tenant ? ["--tenant", A.tenant] : []), "--allow-no-subscriptions", "-o", "none"], { json: false, stdio: "inherit" });
    account = az(["account", "show", "-o", "json"]);
  }
}
const tenantId = A.tenant || account?.tenantId;
if (!tenantId) die("Could not determine tenant ID.");
ok(`Tenant ${tenantId} (${account?.user?.name || "dry-run"})`);

// ---------- 3. Entra app ----------
step("Entra app registration");
let clientId = A.clientId;
if (clientId) ok(`Reusing client ID ${clientId}`);
else if (A.dryRun) dry(`would create/reuse app '${A.appName}'`);
else {
  const existing = az(["ad", "app", "list", "--display-name", A.appName, "-o", "json"]) || [];
  let app = existing.find((x) => x.displayName === A.appName);
  if (app) ok(`Found existing app '${A.appName}' (${app.appId})`);
  else {
    app = az(["ad", "app", "create", "--display-name", A.appName, "--sign-in-audience", "AzureADMyOrg", "--is-fallback-public-client", "true", "--public-client-redirect-uris", "http://localhost", "-o", "json"]);
    ok(`Created app '${A.appName}' (${app.appId})`);
  }
  clientId = app.appId;
  az(["ad", "app", "update", "--id", clientId, "--is-fallback-public-client", "true", "--public-client-redirect-uris", "http://localhost"], { json: false });
  ok("Public client (device-code sign-in) enabled");

  const ppId = A.ppApiId || PP_API;
  let pp = az(["ad", "sp", "show", "--id", ppId, "-o", "json"], { allowFail: true });
  if (!pp) { az(["ad", "sp", "create", "--id", ppId, "-o", "json"], { allowFail: true }); pp = az(["ad", "sp", "show", "--id", ppId, "-o", "json"], { allowFail: true }); }
  const scope = (pp?.oauth2PermissionScopes || []).find((s) => s.value === SCOPE_NAME);
  if (!scope) die(`Power Platform API (${ppId}) or its '${SCOPE_NAME}' permission is not available in this tenant. Check you have rights to add the Power Platform API service principal (Application Administrator or higher) and that the API is available in your cloud.`);
  az(["ad", "app", "permission", "add", "--id", clientId, "--api", ppId, "--api-permissions", `${scope.id}=Scope`], { json: false, allowFail: true });
  ok(`Permission ${SCOPE_NAME} added`);
  az(["ad", "sp", "create", "--id", clientId, "-o", "json"], { allowFail: true });
  const consent = az(["ad", "app", "permission", "admin-consent", "--id", clientId], { json: false, allowFail: true });
  if (consent === null) warn("Admin consent not granted (you may lack rights). Each user will be asked to consent at first sign-in, or ask a Global/Privileged Role admin to grant it.");
  else ok("Admin consent granted");
}

// ---------- 4. environment ----------
step("Power Platform environment");
let envId = A.envId, orgUrl = null, envName = "";
if (A.dryRun && !envId) dry("would discover environments");
else {
  const envs = (az(["rest", "--method", "get", "--resource", "https://service.powerapps.com/", "--url", "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01", "-o", "json"], { allowFail: true })?.value) || [];
  const view = (e) => ({ id: e.name, name: e.properties?.displayName || e.name, def: !!e.properties?.isDefault, org: e.properties?.linkedEnvironmentMetadata?.instanceApiUrl, host: e.properties?.runtimeEndpoints });
  let list = envs.map(view);
  let chosen;
  if (envId) chosen = list.find((e) => e.id.toLowerCase() === envId.toLowerCase()) || { id: envId, name: envId };
  else {
    if (!list.length) die("No environments found. Pass --env-id <guid>.");
    list = list.filter((e) => e.org).length ? list.filter((e) => e.org) : list;
    chosen = list.length === 1 ? list[0] : list.find((e) => e.def);
    if (interactive && list.length > 1) {
      list.forEach((e, i) => console.log(`    ${i + 1}) ${e.name}${e.def ? " (default)" : ""}  ${e.id}`));
      const n = Number(await ask("Pick environment", String(Math.max(1, list.findIndex((e) => e === chosen) + 1))));
      chosen = list[n - 1] || chosen;
    }
    chosen = chosen || list[0];
  }
  envId = chosen.id; orgUrl = chosen.org; envName = chosen.name;
  ok(`${envName} (${envId})`);
}

// ---------- 5. agents ----------
step("Copilot Studio agents");
let agentSpecs = A.agent.slice();
if (!agentSpecs.length) {
  if (A.dryRun) dry("would discover published agents");
  else {
    if (!orgUrl) die("Could not find the environment's Dataverse URL. Pass --agent <schema> explicitly.");
    const tok = az(["account", "get-access-token", "--resource", orgUrl, "-o", "json"]).accessToken;
    const url = `${orgUrl.replace(/\/$/, "")}/api/data/v9.2/bots?$select=name,schemaname,publishedon&$filter=${encodeURIComponent("publishedon ne null")}&$orderby=name`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${tok}`, accept: "application/json" } });
    if (!res.ok) die(`Listing agents failed (${res.status}). Pass --agent <schema> explicitly.\n${(await res.text()).slice(0, 300)}`);
    const bots = (await res.json()).value || [];
    if (!bots.length) die("No published agents found in this environment. Publish one in Copilot Studio, or pass --agent.");
    let pick = bots;
    if (interactive && !A.allAgents && bots.length > 1) {
      bots.forEach((b, i) => console.log(`    ${i + 1}) ${b.name}  (${b.schemaname})`));
      const a = await ask("Agents to expose (numbers, comma-separated, or 'a' for all)", "a");
      pick = a === "a" ? bots : a.split(",").map((n) => bots[Number(n) - 1]).filter(Boolean);
      if (!pick.length) die("No agents selected.");
    }
    const used = new Set();
    agentSpecs = pick.map((b) => { let al = slug(b.name), n = 2; while (used.has(al)) al = `${slug(b.name)}_${n++}`; used.add(al); return `${al}=${b.schemaname}`; });
  }
}
agentSpecs.forEach((s) => ok(s));

// ---------- 6. install server ----------
step("Installing MCP server");
const srcServer = [join(here, "server", "copilot-studio-mcp.mjs"), join(here, "..", "mcp", "copilot-studio-mcp.mjs")].find(existsSync);
if (!srcServer) die("Server file not found next to the installer.");
if (A.dryRun) dry(`would copy server to ${serverDest}`);
else { mkdirSync(dirname(serverDest), { recursive: true }); copyFileSync(srcServer, serverDest); ok(serverDest); }

// ---------- 7. VS Code config ----------
step("Wiring VS Code");
const cfgFile = configPath();
const entry = {
  type: "stdio",
  command: process.execPath,
  args: [serverDest],
  env: {
    TENANT_ID: tenantId, CLIENT_ID: clientId || "<client-id>", ENV_ID: envId || "<env-id>",
    AGENTS: agentSpecs.join(","), HARNESS: A.harness,
    SHOW_REASONING: String(!!A.showReasoning), SHOW_TOOLCALLS: String(!!A.showToolcalls), TOKEN_CACHE: "file",
  },
};
if (A.dryRun) { dry(`would write to ${cfgFile}:\n${JSON.stringify({ servers: { [SERVER_NAME]: entry } }, null, 2)}`); process.exit(0); }
let cfg = {};
if (existsSync(cfgFile)) {
  try { cfg = parseJsonc(readFileSync(cfgFile, "utf8")); } catch (e) { die(`${cfgFile} is not valid JSON(C): ${e.message}. Fix or move it, then re-run.`); }
  writeFileSync(`${cfgFile}.bak`, readFileSync(cfgFile));
  ok(`Backed up existing config to ${cfgFile}.bak`);
}
cfg.servers = { ...(cfg.servers || {}), [SERVER_NAME]: entry };
mkdirSync(dirname(cfgFile), { recursive: true });
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
ok(`Wrote '${SERVER_NAME}' to ${cfgFile}`);
writeFileSync(stateFile, JSON.stringify({ clientId, tenantId, envId, agents: agentSpecs, configPath: cfgFile, installedAt: new Date().toISOString() }, null, 2));

// ---------- 8. verify ----------
if (!A.noVerify) {
  step("Sign-in and connectivity check");
  console.log("    A device-code prompt appears below the first time. Open the URL, enter the code, and sign in.\n");
  const code = await new Promise((res) => {
    const ch = spawn(process.execPath, [serverDest, "--diagnose"], { env: { ...process.env, ...entry.env }, stdio: "inherit" });
    ch.on("exit", res);
  });
  if (code === 0) ok("Verified: sign-in works and every agent responded.");
  else warn("Check failed (see above). The VS Code entry is installed; fix the issue and re-run this script, or use the copilot_studio_diagnose tool in VS Code.");
}

// ---------- done ----------
console.log(`
${c(32, "Done.")} Connect in VS Code:
  1. Reload VS Code (Ctrl/Cmd+Shift+P -> "Developer: Reload Window"). VS Code 1.99+ with GitHub Copilot.
  2. Open Copilot Chat, switch the mode to "Agent", click the tools icon, and make sure '${SERVER_NAME}' tools are ticked.
  3. Ask e.g. "Use ask_${(agentSpecs[0] || "agent=x").split("=")[0]} to say hello".
  Manage servers: Ctrl/Cmd+Shift+P -> "MCP: List Servers". Undo everything: node provision.mjs --remove
`);
