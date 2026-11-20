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
if scenario == "rerun":
    expect(not creates and len(updates) == 1, "second run must update in place, not create")
    expect(find("containerapp", "identity", "assign") and find("containerapp", "registry", "set"), "identity/registry re-set on upgrade")
    app_call, flag = updates[0], "--replace-env-vars"
    expect(not find("ad", "app", "credential", "reset"), "connector secret must NOT be rotated on a re-run")
    expect((work / "out" / "connector-client-secret.txt").read_text() == (work / "secret.before").read_text(), "secret file unchanged")
    expect(not find("storage", "account", "create") and not find("containerapp", "env", "create"), "existing resources are not re-created")
else:
    expect(len(creates) == 1 and not updates, "first run creates the app")
    app_call, flag = creates[0], "--env-vars"
    expect(containers == {"tfstate", "plans", "audit"}, f"containers {containers}")
    expect("--user-assigned" in app_call and "--registry-identity" in app_call, "user-assigned identity on the app")
    expect(len(find("ad", "app", "credential", "reset")) == 1, "connector secret created once")
    expect(opt(find("storage", "account", "create")[0], "--allow-shared-key-access") == "false", "shared key access off")
env = env_vars(app_call, flag)
envs = json.loads(base64.b64decode(env["ENVIRONMENTS_B64"]))
expect(env["AUTH_MODE"] == "jwt" and env["SUBSCRIPTION_ID"] == SUB and env["TENANT_ID"].count("-") == 4, f"env vars {sorted(env)}")
api_id = env["API_AUDIENCES"].split(",")[0]
expect(env["API_AUDIENCES"] == f"{api_id},api://{api_id}" and len(api_id) == 36, "API audiences")
expect(len(env["AZURE_CLIENT_ID"]) == 36 and env["STATE_SA"].startswith("st"), "identity client id and state account")
expect(opt(app_call, "--image").endswith(image_tags[0]), "app uses the image that was just built")
auth = find("containerapp", "auth", "microsoft", "update")[0]
expect(opt(auth, "--client-id") == api_id and opt(auth, "--allowed-audiences") == f"api://{api_id}" and "--client-secret" not in auth, "Easy Auth config")
expect(opt(find("containerapp", "auth", "update")[0], "--unauthenticated-client-action") == "Return401", "anonymous -> 401")
for name, cfg in envs.items():
    scope = f"/subscriptions/{cfg['subscription_id']}/resourceGroups/{cfg['resource_group']}"
    expect(("Contributor", scope) in roles, f"Contributor on {scope}")
    expect(any(opt(c, "-n") == cfg["resource_group"] and opt(c, "--subscription") == cfg["subscription_id"] for c in find("group", "create") if "--subscription" in c), f"resource group for {name}")
expect(all(r[0] != "Owner" and not (r[0] == "Contributor" and r[1].count("/") < 4) for r in roles), "no subscription-wide or Owner role assignments")
expect(sum(1 for r in roles if r[0] == "Contributor") == len(envs), "Contributor only on the environment resource groups")

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
expect(all(secret not in " ".join(c) for c in calls), "client secret never passed back to az / app settings")
expect(f"https://{swagger['host']}/mcp" in wizard and "OAuth 2.0 > Manual" in wizard, "wizard values")
graph = [c for c in find("rest") if "PATCH" in c][0]
expect(opt(graph, "--body").startswith("@"), "Graph body passed as a file")

if scenario == "default":
    expect(list(envs) == ["dev"] and envs["dev"] == {"resource_group": "rg-aztfmcp-dev", "subscription_id": SUB, "allowed_locations": ["eastus2"],
                                                     "policy_profile": "standard", "enable_apply": False, "enable_destroy": False,
                                                     "require_approval": False, "allow_ephemeral": True}, f"default environments {envs}")
    expect(not find("containerapp", "job", "create") and not find("deployment", "group", "create") and not find("network", "vnet", "create"), "optional parts are off by default")
    expect(opt(app_call, "--ingress") == "external" and opt(app_call, "--min-replicas") == "1" and opt(app_call, "--max-replicas") == "3", "ingress/replicas")
    expect("--infrastructure-subnet-resource-id" not in find("containerapp", "env", "create")[0], "no VNet by default")
if scenario == "full":
    expect(list(envs) == ["dev", "test", "prod"], "three environments")
    expect(envs["prod"]["require_approval"] is True and envs["prod"]["policy_profile"] == "strict" and envs["prod"]["allow_ephemeral"] is False, "prod guardrails")
    expect(envs["prod"]["approver_group_ids"] == ["99999999-0000-0000-0000-000000000009"] and "approver_group_ids" not in envs["dev"], "approver group only on prod")
    expect(envs["dev"]["enable_apply"] is True and envs["dev"]["monthly_budget_usd"] == 2000 and envs["dev"]["allow_ephemeral"] is True, "dev settings")
    jobs = find("containerapp", "job", "create")
    expect([opt(j, "-n") for j in jobs] == ["caj-aztfmcp-reaper", "caj-aztfmcp-drift"], "two scheduled jobs")
    expect(opt(jobs[0], "--cron-expression") == "*/15 * * * *" and opt(jobs[1], "--cron-expression") == "0 3 * * *", "cron expressions survive quoting")
    expect(multi(jobs[0], "--args") == ["server.py", "job", "reaper"] and multi(jobs[1], "--args") == ["server.py", "job", "drift"], "job commands")
    expect(env_vars(jobs[0], "--env-vars") == env and "--mi-user-assigned" in jobs[0], "jobs share the server's configuration and identity")
    mon = find("deployment", "group", "create")[0]
    expect("alertEmail=ops@contoso.com" in mon and any(a.startswith("workspaceResourceId=/subscriptions/") for a in mon), "monitoring deployment parameters")
    env_create = find("containerapp", "env", "create")[0]
    expect("--infrastructure-subnet-resource-id" in env_create and "--internal-only" not in env_create, "VNet-integrated environment, external ingress")
    expect(find("network", "private-endpoint", "create") and opt(find("network", "private-endpoint", "create")[0], "--group-id") == "blob", "storage private endpoint")
    upd = [c for c in find("storage", "account", "update") if "--public-network-access" in c]
    expect(upd and opt(upd[0], "--public-network-access") == "Disabled", "state storage closed to the internet")
    expect([opt(c, "--ip-address") for c in find("containerapp", "ingress", "access-restriction", "set")] == ["203.0.113.0/24", "198.51.100.7/32"], "IP allow-list")
    expect(opt(app_call, "--max-replicas") == "4", "max replicas")
    body_patch = [c for c in find("rest") if "POST" in c]
    expect(len(body_patch) == 1 and "appRoleAssignedTo" in opt(body_patch[0], "--uri"), "group restriction")
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
settings = Settings.from_env(env)
expect(sorted(settings.environments) == sorted(envs), "server parses the generated configuration")
print(f"OK   {scenario}: {len(calls)} az calls verified")
