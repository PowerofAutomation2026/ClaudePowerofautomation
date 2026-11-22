"""Assertions on what a deploy-script run asked the (fake) Azure CLI to do. Used by test-deploy-script.sh."""
import base64
import json
import pathlib
import sys

work, scenario = pathlib.Path(sys.argv[1]), sys.argv[2]
calls = [json.loads(line) for line in (work / f"{scenario}.log").read_text().splitlines() if line.strip()]
out = (work / f"{scenario}.out").read_text()
SUB = "11111111-1111-1111-1111-111111111111"


def find(*prefix):
    return [c for c in calls if c[:len(prefix)] == list(prefix)]


def opt(call, name):
    return call[call.index(name) + 1]


def multi(call, name):
    i = call.index(name) + 1
    vals = []
    while i < len(call) and not call[i].startswith("--"):
        vals.append(call[i])
        i += 1
    return vals


def env_vars(call, flag):
    return dict(v.split("=", 1) for v in multi(call, flag))


def swagger_host():
    return json.loads((work / "out" / "terraform-mcp.swagger.json").read_text())["host"]


def expect(cond, msg):
    if not cond:
        print(f"CHECK FAILED [{scenario}]: {msg}")
        print(out[-1500:])
        sys.exit(1)


for c in calls:
    expect(all(isinstance(a, str) and a != "" for a in c), f"empty argument passed to az: {c}")
    expect(not any("System.Object" in a or "System.Collections" in a for a in c), f"an object was stringified into an az argument: {c}")

if scenario == "destroy":
    expect(find("group", "delete") and opt(find("group", "delete")[0], "-n") == "rg-aztfmcp", "resource group delete")
    expect(not find("containerapp", "create") and not find("acr", "build"), "destroy must not deploy anything")
    print("OK   destroy")
    sys.exit(0)

expect("================ DONE ================" in out, "script did not finish")
expect(find("account", "set") and opt(find("account", "set")[0], "--subscription") == SUB, "subscription selected")
sa = opt(find("storage", "account", "create")[0], "-n") if find("storage", "account", "create") else None
containers = {opt(c, "-n") for c in find("storage", "container-rm", "create")}
roles = [(opt(c, "--role"), opt(c, "--scope")) for c in find("role", "assignment", "create")]
build = find("acr", "build")
expect(len(build) == 1 and "--no-logs" in build[0], "one image build")
image_tags = [build[0][i + 1] for i, a in enumerate(build[0]) if a == "-t"]
expect(len(image_tags) == 2 and image_tags[1] == "azure-terraform-mcp:latest", f"image tags {image_tags}")

creates, updates = find("containerapp", "create"), [c for c in find("containerapp", "update") if "--image" in c]
by_name = lambda cs: {opt(c, "-n"): c for c in cs}  # noqa: E731
FRONT, BACK = f"ca-{'custom1' if scenario == 'file' else 'aztfmcp'}", f"ca-{'custom1' if scenario == 'file' else 'aztfmcp'}-approval"
if scenario == "rerun":
    expect(not creates and set(by_name(updates)) == {FRONT, BACK}, "second run must update both apps in place, not create")
    expect(find("containerapp", "identity", "assign") and find("containerapp", "registry", "set"), "identity/registry re-set on upgrade")
    app_call, back_call, flag = by_name(updates)[FRONT], by_name(updates)[BACK], "--replace-env-vars"
    expect(not find("ad", "app", "credential", "reset"), "connector secret must NOT be rotated on a re-run")
    expect((work / "out" / "connector-client-secret.txt").read_text() == (work / "secret.before").read_text(), "secret file unchanged")
    expect(not find("storage", "account", "create") and not find("containerapp", "env", "create"), "existing resources are not re-created")
else:
    expect(set(by_name(creates)) == {FRONT, BACK} and not updates, "first run creates the front-end and the approval app")
    app_call, back_call, flag = by_name(creates)[FRONT], by_name(creates)[BACK], "--env-vars"
    expect(containers == {"tfstate", "plans", "audit", "control"}, f"containers {containers}")
    expect(opt(app_call, "--user-assigned") != opt(back_call, "--user-assigned"), "front-end and executor use DIFFERENT identities")
    expect("--user-assigned" in app_call and "--registry-identity" in app_call, "user-assigned identity on the app")
    expect(len(find("ad", "app", "credential", "reset")) == 1, "connector secret created once")
    expect(opt(find("storage", "account", "create")[0], "--allow-shared-key-access") == "false", "shared key access off")
env = env_vars(app_call, flag)
back_env = env_vars(back_call, flag)
envs = json.loads(base64.b64decode(env["ENVIRONMENTS_B64"]))
expect(env["TFMCP_ROLE"] == "frontend" and back_env["TFMCP_ROLE"] == "approval", "process roles")
expect(env["AZURE_CLIENT_ID"] != back_env["AZURE_CLIENT_ID"], "different managed identity client ids")
expect(env["REQUIRED_SCOPE"] == "access_as_user" and len(env["ALLOWED_CLIENT_IDS"].split(",")[0]) == 36, "client allow-list")
expect(env["APPROVAL_BASE_URL"].startswith("https://") and BACK in env["APPROVAL_BASE_URL"], "front-end knows the approval page URL")
appr_id = back_env["APPROVAL_CLIENT_IDS"]
expect(back_env["APPROVAL_AUDIENCES"] == f"{appr_id},api://{appr_id}" and appr_id != env["API_AUDIENCES"].split(",")[0], "approval uses a separate Entra app / audience")
# ---- identities and least privilege
plan_role = [r for r in roles if r[0].startswith("Azure Terraform MCP Plan")]
apply_role = [r for r in roles if r[0].startswith("Azure Terraform MCP Apply")]
assignee = {(opt(c, "--role"), opt(c, "--scope")): opt(c, "--assignee-object-id") for c in find("role", "assignment", "create")}
plan_pid = assignee[plan_role[0]]
apply_pid = assignee[apply_role[0]]
expect(plan_pid != apply_pid, "two principals")
plan_roles = {(r, sc.rsplit("/", 1)[-1]) for (r, sc), pid in assignee.items() if pid == plan_pid}
expect(not any(r in ("Contributor", "Owner") or r.startswith("Azure Terraform MCP Apply") for r, _ in plan_roles), f"front-end identity has no write role: {plan_roles}")
expect(("Storage Blob Data Reader", "tfstate") in plan_roles and ("Storage Blob Data Reader", "control") in plan_roles, "front-end: read-only on state and control")
expect(("Storage Blob Data Contributor", "plans") in plan_roles and ("Storage Blob Data Contributor", "control") not in plan_roles, "front-end cannot write approvals")
expect(not any(r[0] in ("Contributor", "Owner", "User Access Administrator") for r in roles), "built-in Contributor/Owner are not used at all")
for kind in ("plan", "apply", "applyProtected"):
    d = json.loads((work / "out" / f"role-{kind}.json").read_text())
    expect(d["IsCustom"] is True and all(sc.startswith("/subscriptions/") for sc in d["AssignableScopes"]), f"role file {kind}")
plan_def = json.loads((work / "out" / "role-plan.json").read_text())
apply_def = json.loads((work / "out" / "role-apply.json").read_text())
prot_def = json.loads((work / "out" / "role-applyProtected.json").read_text())
expect(plan_def["Actions"] == ["*/read"] and plan_def["NotActions"] == [], "plan role is read-only")
for needed in ("Microsoft.Authorization/*/Write", "Microsoft.Authorization/*/Delete", "Microsoft.Resources/subscriptions/resourceGroups/delete"):
    expect(needed in apply_def["NotActions"] and needed in prot_def["NotActions"], f"apply roles exclude {needed}")
expect("Microsoft.Sql/servers/databases/delete" in prot_def["NotActions"] and "Microsoft.Sql/servers/databases/delete" not in apply_def["NotActions"], "protected role blocks data deletes")
locks = find("lock", "create")
expect(any(opt(c, "--resource-group") == f"rg-{'custom1' if scenario == 'file' else 'aztfmcp'}" and opt(c, "--lock-type") == "CanNotDelete" for c in locks), "MCP resource group is locked")
graph_patches = [c for c in find("rest") if "PATCH" in c]
expect(len(graph_patches) == 3, "API app + approval app (twice: before and after its URL is known)")
expect(env["AUTH_MODE"] == "jwt" and env["SUBSCRIPTION_ID"] == SUB and env["TENANT_ID"].count("-") == 4, f"env vars {sorted(env)}")
api_id = env["API_AUDIENCES"].split(",")[0]
expect(env["API_AUDIENCES"] == f"{api_id},api://{api_id}" and len(api_id) == 36, "API audiences")
expect(len(env["AZURE_CLIENT_ID"]) == 36 and env["STATE_SA"].startswith("st"), "identity client id and state account")
expect(opt(app_call, "--image").endswith(image_tags[0]), "app uses the image that was just built")
auth = find("containerapp", "auth", "microsoft", "update")[0]
expect(opt(auth, "--client-id") == api_id and opt(auth, "--allowed-audiences") == f"api://{api_id}" and "--client-secret" not in auth, "Easy Auth config")
dynamic = scenario != "manual"
expect(opt(find("containerapp", "auth", "update")[0], "--unauthenticated-client-action") == ("AllowAnonymous" if dynamic else "Return401"), "Easy Auth action matches the connector mode")
set_base = [c for c in find("containerapp", "update") if "--set-env-vars" in c and any(a.startswith("PUBLIC_BASE_URL=") for a in c)]
if dynamic:
    expect(env["CONNECTOR_AUTH"] == "dynamic" and env["CONNECTOR_CLIENT_SECRET"] == "secretref:connector-secret", "facade on; secret only as a secret reference")
    expect(env["OAUTH_SCOPE"] == f"api://{api_id}/access_as_user" and env["REDIRECT_URIS"].split(",")[0] == "https://global.consent.azure-apim.net/redirect", "scope and redirect allow-list")
    expect("--secrets" in app_call or find("containerapp", "secret", "set"), "connector secret stored as a Container Apps secret")
    expect("CONNECTOR_AUTH" not in back_env and "CONNECTOR_CLIENT_SECRET" not in back_env, "the approval service gets no facade and no connector secret")
    if scenario == "rerun":
        expect(env.get("PUBLIC_BASE_URL", "").startswith("https://ca-") and not set_base, "re-run knows the public URL up front")
    else:
        expect(len(set_base) == 1 and opt(set_base[0], "-n") == FRONT, "public base URL set after the first creation")
        env["PUBLIC_BASE_URL"] = [a for a in set_base[0] if a.startswith("PUBLIC_BASE_URL=")][0].split("=", 1)[1]
    expect(env["PUBLIC_BASE_URL"] == f"https://{swagger_host()}", "PUBLIC_BASE_URL is the app's own address")
    upd = find("ad", "app", "update")
    expect(upd and "https://global.consent.azure-apim.net/redirect" in upd[0], "redirect URIs registered on the connector app")
else:
    expect("CONNECTOR_AUTH" not in env and "CONNECTOR_CLIENT_SECRET" not in env and not set_base, "manual mode: no facade settings")
for name, cfg in envs.items():
    scope = f"/subscriptions/{cfg['subscription_id']}/resourceGroups/{cfg['resource_group']}"
    expect(any(r == (plan_role[0][0], scope) for r in roles) and any(r[1] == scope for r in apply_role), f"plan + apply roles on {scope}")
    expect(any(opt(c, "-n") == cfg["resource_group"] and opt(c, "--subscription") == cfg["subscription_id"] for c in find("group", "create") if "--subscription" in c), f"resource group for {name}")
expect(all(r[1].count("/") >= 4 for r in roles), "no subscription-wide role assignments")
expect(len([r for r in apply_role]) == len(envs), "apply role only on the environment resource groups")

swagger = json.loads((work / "out" / "terraform-mcp.swagger.json").read_text())
post = swagger["paths"]["/mcp"]["post"]
expect(post["x-ms-agentic-protocol"] == "mcp-streamable-1.0" and swagger["host"].endswith("azurecontainerapps.io"), "swagger")
expect(isinstance(post["parameters"], list) and isinstance(swagger["schemes"], list) and isinstance(swagger["security"], list), "swagger arrays stay arrays")
expect(f"api://{api_id}/access_as_user" in swagger["securityDefinitions"]["oauth2_auth"]["scopes"], "swagger scope")
props = json.loads((work / "out" / "apiProperties.json").read_text())
oauth = props["properties"]["connectionParameters"]["token"]["oAuthSettings"]
expect(oauth["scopes"] == [f"api://{api_id}/access_as_user"] and len(oauth["clientId"]) == 36, "apiProperties")
secret = (work / "out" / "connector-client-secret.txt").read_text()
wizard = (work / "out" / "copilot-studio-wizard-values.md").read_text()
expect(secret and secret not in wizard and secret not in json.dumps(swagger) + json.dumps(props) and secret not in out, "client secret only in its own file")
leaks = [c for c in calls if any(secret in a and not a.startswith("connector-secret=") for a in c)]
expect(not leaks, "client secret reaches az only as the value of the Container Apps secret 'connector-secret'")
if scenario == "manual":
    expect(all(secret not in " ".join(c) for c in calls), "manual mode: the secret is never passed to az")
expect(f"https://{swagger['host']}/mcp" in wizard and "OAuth 2.0 > Manual" in wizard, "wizard values")
if scenario != "manual":
    expect("Dynamic discovery" in wizard and wizard.index("Dynamic discovery") < wizard.index("FALLBACK") < wizard.index("OAuth 2.0 > Manual"), "dynamic is primary, manual is the fallback")
else:
    expect("Dynamic discovery" not in wizard, "manual mode keeps the old wizard file")
graph = graph_patches[0]
expect(opt(graph, "--body").startswith("@"), "Graph body passed as a file")

if scenario in ("default", "manual"):
    expect(list(envs) == ["dev"] and envs["dev"] == {"resource_group": "rg-aztfmcp-dev", "subscription_id": SUB, "allowed_locations": ["eastus2"],
                                                     "policy_profile": "standard", "enable_apply": False, "enable_destroy": False,
                                                     "require_approval": False, "allow_ephemeral": True, "allow_self_approval": True}, f"default environments {envs}")
    expect("04b07795" not in env["ALLOWED_CLIENT_IDS"] and not find("policy", "assignment", "create"), "Azure CLI client and deny policy are opt-in")
    expect(len(locks) == 1, "only the MCP resource group is locked when there is no prod environment")
    expect(not find("containerapp", "job", "create") and not find("deployment", "group", "create") and not find("network", "vnet", "create"), "optional parts are off by default")
    expect(opt(app_call, "--ingress") == "external" and opt(app_call, "--min-replicas") == "1" and opt(app_call, "--max-replicas") == "3", "ingress/replicas")
    expect("--infrastructure-subnet-resource-id" not in find("containerapp", "env", "create")[0], "no VNet by default")
if scenario == "full":
    expect(list(envs) == ["dev", "test", "prod"], "three environments")
    expect(envs["prod"]["require_approval"] is True and envs["prod"]["policy_profile"] == "strict" and envs["prod"]["allow_ephemeral"] is False, "prod guardrails")
    prod_scope = f"/subscriptions/{SUB}/resourceGroups/rg-aztfmcp-prod"
    expect(("Azure Terraform MCP Apply protected (aztfmcp)", prod_scope) in roles and ("Azure Terraform MCP Apply (aztfmcp)", prod_scope) not in roles, "prod gets the protected apply role")
    expect(any(opt(c, "--resource-group") == "rg-aztfmcp-prod" for c in locks) and len(locks) == 2, "prod resource group is locked")
    expect(len(find("policy", "assignment", "create")) == 3, "deny-delete policy assigned per environment")
    role_posts = [json.dumps(c) for c in find("rest") if "POST" in c and "appRoleAssignedTo" in opt(c, "--uri")]
    expect(len(role_posts) == 6, f"group -> app role assignments (3 on the API app, 2 on the approval app, 1 access group): {len(role_posts)}")
    expect("04b07795-8ddb-461a-bbee-02f9e1bf7b46" in env["ALLOWED_CLIENT_IDS"] and back_env["APPROVAL_REQUIRE_AMR"] == "mfa", "opt-in switches")
    expect("--secrets" in back_call and back_env["NOTIFY_WEBHOOK_URL"] == "secretref:notify-webhook" and "hooks.example" not in json.dumps(back_env), "webhook URL is a secret, not an env value")
    expect(find("storage", "container", "immutability-policy", "create"), "audit WORM policy")
    expect(envs["dev"]["enable_apply"] is True and envs["dev"]["monthly_budget_usd"] == 2000 and envs["dev"]["allow_ephemeral"] is True, "dev settings")
    jobs = find("containerapp", "job", "create")
    expect([opt(j, "-n") for j in jobs] == ["caj-aztfmcp-reaper", "caj-aztfmcp-drift"], "two scheduled jobs")
    expect(opt(jobs[0], "--cron-expression") == "*/15 * * * *" and opt(jobs[1], "--cron-expression") == "0 3 * * *", "cron expressions survive quoting")
    expect(multi(jobs[0], "--args") == ["server.py", "job", "reaper"] and multi(jobs[1], "--args") == ["server.py", "job", "drift"], "job commands")
    expect(env_vars(jobs[0], "--env-vars")["TFMCP_ROLE"] == "approval" and env_vars(jobs[1], "--env-vars")["TFMCP_ROLE"] == "frontend", "reaper is privileged, drift scan is read-only")
    expect(opt(jobs[0], "--mi-user-assigned") == opt(back_call, "--user-assigned") and opt(jobs[1], "--mi-user-assigned") == opt(app_call, "--user-assigned"), "job identities")
    mon = find("deployment", "group", "create")[0]
    expect("alertEmail=ops@contoso.com" in mon and any(a.startswith("workspaceResourceId=/subscriptions/") for a in mon), "monitoring deployment parameters")
    env_create = find("containerapp", "env", "create")[0]
    expect("--infrastructure-subnet-resource-id" in env_create and "--internal-only" not in env_create, "VNet-integrated environment, external ingress")
    expect(find("network", "private-endpoint", "create") and opt(find("network", "private-endpoint", "create")[0], "--group-id") == "blob", "storage private endpoint")
    upd = [c for c in find("storage", "account", "update") if "--public-network-access" in c]
    expect(upd and opt(upd[0], "--public-network-access") == "Disabled", "state storage closed to the internet")
    acl = find("containerapp", "ingress", "access-restriction", "set")
    expect([opt(c, "--ip-address") for c in acl if opt(c, "-n") == FRONT] == ["203.0.113.0/24", "198.51.100.7/32"], "IP allow-list (MCP)")
    expect([opt(c, "--ip-address") for c in acl if opt(c, "-n") == BACK] == ["203.0.113.0/24"], "IP allow-list (approval page)")
    expect(env["REDIRECT_URIS"] == "https://global.consent.azure-apim.net/redirect,https://copilot.example/cb", "extra redirect URI")
    expect(opt(app_call, "--max-replicas") == "4", "max replicas")

if scenario == "rerun":
    expect(list(envs) == ["dev", "prod"] and "NOTIFY_WEBHOOK_URL" not in env, "re-run replaces the environment configuration")
if scenario == "file":
    expect(list(envs) == ["sandbox", "prod"] and envs["prod"]["subscription_id"] == "33333333-3333-3333-3333-333333333333", "environments from file")
    expect(envs["sandbox"]["subscription_id"] == SUB and envs["sandbox"]["max_ttl_hours"] == 48, "defaults filled for file environments")
    expect(any(c[:2] == ["provider", "register"] and "--subscription" in c and opt(c, "--subscription") == "33333333-3333-3333-3333-333333333333" for c in calls), "providers registered in the prod subscription")
    expect(env["DEFAULT_ENVIRONMENT"] == "sandbox" and opt(app_call, "-n") == "ca-custom1", "prefix and default environment")
# the server must accept exactly what the script generated
sys.path.insert(0, str(work / "server"))
from tfmcp.config import Settings  # noqa: E402
for e in (env, back_env):
    settings = Settings.from_env({**e, "NOTIFY_WEBHOOK_URL": "https://x"})
    expect(settings.connector_auth == ("dynamic" if dynamic and e is env else "manual"), "connector mode parsed by the server")
    expect(sorted(settings.environments) == sorted(envs), "server parses the generated configuration")
print(f"OK   {scenario}: {len(calls)} az calls verified")
