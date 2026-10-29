#!/usr/bin/env node
// Fake Azure CLI for the provisioning lab. State in $FAKE_AZ_STATE; mock Dataverse/BAP at $FAKE_AZ_MOCK.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const a = process.argv.slice(2), S = process.env.FAKE_AZ_STATE;
const st = existsSync(S) ? JSON.parse(readFileSync(S, "utf8")) : { apps: [], sps: [], perms: [], consent: [], calls: [] };
const save = () => writeFileSync(S, JSON.stringify(st));
st.calls.push(a.join(" ")); save();
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const fail = (m) => { console.error(m); process.exit(1); };
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const cmd = a.slice(0, 3).join(" ");
const PP = "8578e004-a5c6-46e7-913e-12f58912df43";
if (a[0] === "--version") out({ "azure-cli": "2.99" });
if (a[0] === "account" && a[1] === "show") { if (process.env.FAKE_AZ_LOGGED_OUT && !st.loggedIn) fail("Please run 'az login'"); out({ tenantId: "tenant-1", user: { name: "me@contoso.com" } }); }
if (a[0] === "login") { st.loggedIn = true; save(); out({}); }
if (cmd === "ad app list") out(st.apps.filter((x) => x.displayName === flag("--display-name")));
if (cmd === "ad app create") { const app = { appId: `app-${st.apps.length + 1}`, displayName: flag("--display-name"), pub: flag("--is-fallback-public-client"), redirect: flag("--public-client-redirect-uris") }; st.apps.push(app); save(); out(app); }
if (cmd === "ad app update") { const x = st.apps.find((y) => y.appId === flag("--id")); if (!x) fail("no app"); x.pub = flag("--is-fallback-public-client"); save(); out({}); }
if (cmd === "ad app delete") { st.apps = st.apps.filter((y) => y.appId !== flag("--id")); save(); out({}); }
if (cmd === "ad sp show") { if (flag("--id") !== PP && !process.env.FAKE_AZ_ANY_PP) fail("not found"); out({ oauth2PermissionScopes: process.env.FAKE_AZ_NO_SCOPE ? [] : [{ id: "scope-guid-1", value: "CopilotStudio.Copilots.Invoke" }, { id: "x", value: "Other" }] }); }
if (cmd === "ad sp create") { st.sps.push(flag("--id")); save(); out({}); }
if (a.slice(0, 4).join(" ") === "ad app permission add") { st.perms.push({ app: flag("--id"), api: flag("--api"), perm: flag("--api-permissions") }); save(); out({}); }
if (a.slice(0, 4).join(" ") === "ad app permission admin-consent") { if (process.env.FAKE_AZ_CONSENT_FAIL) fail("Insufficient privileges"); st.consent.push(flag("--id")); save(); process.exit(0); }
if (a[0] === "rest") out({ value: JSON.parse(process.env.FAKE_AZ_ENVS) });
if (a[0] === "account" && a[1] === "get-access-token") out({ accessToken: "dv-token" });
fail(`fake az: unhandled ${a.join(" ")}`);
