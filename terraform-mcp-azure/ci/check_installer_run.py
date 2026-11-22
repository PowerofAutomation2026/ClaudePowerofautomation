"""Assertions on an installer run against the fake az / pac CLIs. Used by test-installer.sh."""
import json
import pathlib
import re
import sys

work, name = pathlib.Path(sys.argv[1]), sys.argv[2]
az = [json.loads(x) for x in (work / f"{name}.az.log").read_text().splitlines() if x.strip()]
pac = [json.loads(x) for x in (work / f"{name}.pac.log").read_text().splitlines() if x.strip()]
out = re.sub(r"\x1b\[[0-9;]*m", "", (work / f"{name}.out").read_text())


def find(calls, *prefix):
    return [c for c in calls if c[:len(prefix)] == list(prefix)]


def opt(call, flag):
    return call[call.index(flag) + 1]


def expect(cond, msg):
    if not cond:
        print(f"CHECK FAILED [{name}]: {msg}\n{out[-1800:]}")
        sys.exit(1)


changing = find(az, "group", "create") + find(az, "ad", "group", "create") + find(az, "containerapp", "create") + find(az, "ad", "app", "create") + find(az, "acr", "build")
summary_file = work / "out" / "install-summary.json"
summary = json.loads(summary_file.read_text()) if summary_file.exists() else {}
logs = list((work / ".deploy-logs").glob("install-*.log"))
expect(logs, "a transcript is written to .deploy-logs")

if name in ("preflight", "whatif", "badpreflight"):
    expect(not changing and not find(pac, "connector", "create"), "preflight changes nothing")
    expect("PASS  Subscription role" in out or "FAIL  Subscription role" in out, "PASS/FAIL list is printed")
    if name == "badpreflight":
        expect("FAIL  Subscription role - found: Reader" in out and "fix: Ask an Owner to run: az role assignment create" in out, "failed check names the exact fix")
        expect(summary["result"] == "preflight-failed", "summary result")
    else:
        expect(summary["result"] == "preflight-ok" and "PASS  Container Apps available in region - eastus2" in out, "preflight ok")
        expect("PASS  Power Platform environment - Platform Engineering" in out and "WARN  DLP policies" in out, "Power Platform checks")
        expect(("WHAT WOULD HAPPEN" in out) == (name == "whatif"), "-WhatIf prints the plan")
    print(f"OK   {name}")
    sys.exit(0)
if name == "blocked":
    expect(not changing and "Nothing has been changed yet" in out and "INSTALL STOPPED" in out, "failed preflight stops before any change")
    print("OK   blocked"); sys.exit(0)
if name == "failure":
    expect("INSTALL STOPPED" in out and "run the installer again" in out and len(find(az, "ad", "group", "create")) == 4, "failure after the groups step")
    expect(json.loads((work / ".deploy-state" / "install-state.json").read_text())["status"] == "failed", "state says failed")
    expect(summary.get("result") == "failed" and "simulated failure" in summary.get("error", ""), "summary records the error")
    print("OK   failure"); sys.exit(0)
if name == "uninstall":
    expect(find(az, "group", "delete") and len(find(az, "ad", "group", "delete")) == 4 and not find(az, "containerapp", "create"), "uninstall removes the server and the groups")
    expect("NOT removed" in out and summary["result"] == "uninstalled", "uninstall explains what is left")
    print("OK   uninstall"); sys.exit(0)

# ---- successful installs
expect("INSTALLED" in out and summary["result"] == "succeeded", "installer finished")
deploys = find(az, "containerapp", "create") + [c for c in find(az, "containerapp", "update") if "--image" in c]
expect(len(deploys) == 2, "both container apps deployed")
role_posts = [c for c in find(az, "rest") if "POST" in c and "appRoleAssignedTo" in " ".join(c)]
expect(len(role_posts) == 5, f"four groups mapped to app roles on the two apps ({len(role_posts)})")
for f in ("install-summary.md", "agent-setup.md", "what-users-do-now.md", "terraform-mcp.swagger.json"):
    expect((work / "out" / f).exists(), f"out/{f} written")
secret = (work / "out" / "connector-client-secret.txt").read_text()
everything = summary_file.read_text() + (work / "out" / "install-summary.md").read_text() + (work / "out" / "agent-setup.md").read_text() + "".join(p.read_text() for p in logs)
expect(secret not in everything, "the client secret is in no summary and no log")
expect(summary["mcpUrl"].endswith("/mcp") and "-approval" in summary["approvalUrl"] and set(summary["groups"]) == {"viewers", "requesters", "approvers", "admins"}, "summary content")
expect("sign in" in (work / "out" / "what-users-do-now.md").read_text().lower(), "user message")
expect(not find(pac, "connector", "create") or "--api-definition-file" in find(pac, "connector", "create")[0], "pac arguments")

if name in ("install", "install2", "resume", "wizard", "pacfail"):
    created = [opt(c, "--display-name") for c in find(az, "ad", "group", "create")]
    if name != "resume":
        expect(sorted(created) == ["Azure Terraform MCP Admins", "Azure Terraform MCP Approvers", "Azure Terraform MCP Requesters", "Azure Terraform MCP Viewers"], f"groups created: {created}")
        adds = find(az, "ad", "group", "member", "add")
        expect(len(adds) == (3 if name != "wizard" else 2), f"installer added to admins+requesters, second approver to approvers ({len(adds)})")
    else:
        expect(not created and "already done in the previous (failed) run - skipped" in out, "resume skips the finished groups step")
if name == "install":
    c = find(pac, "connector", "create")
    expect(len(c) == 1 and opt(c[0], "--solution-unique-name") == "AzureTerraformMcp" and opt(c[0], "--environment") == "https://platform.crm.dynamics.com", "connector created in the solution, in the chosen environment")
    dv = [c for c in find(az, "rest") if "POST" in c and "/api/data/v9.2/" in " ".join(c)]
    expect(len(dv) == 2 and all(opt(c, "--resource") == "https://platform.crm.dynamics.com" for c in dv), "publisher + solution created through Dataverse")
    expect(summary["powerPlatform"]["connector"] == "created" and summary["powerPlatform"]["agent"] == "manual", "honest Power Platform result")
    expect(any("--enable-apply" in x or "ENVIRONMENTS_B64" in " ".join(c) for c in deploys for x in c), "deploy script received the configuration")
    expect(len(find(az, "lock", "create")) == 2 and find(az, "policy", "assignment", "create"), "config switches reach the deploy script")
    expect(summary["smokeTest"] == "skipped", "smoke test skipped on request is reported as skipped")
if name == "rerun":
    expect(not find(az, "ad", "group", "create") and not find(az, "ad", "group", "member", "add"), "re-run creates no groups and adds nobody twice")
    expect(find(pac, "connector", "update") and not find(pac, "connector", "create"), "re-run updates the connector")
    expect(not [c for c in find(az, "rest") if "POST" in c and "/api/data/" in " ".join(c)], "solution is reused")
    expect(not find(az, "ad", "app", "credential", "reset"), "connector secret kept")
if name == "pacfail":
    expect(summary["powerPlatform"]["connector"].startswith("failed") and "Follow out/agent-setup.md" in out, "Power Platform failure does not fail the install")
if name == "wizard":
    expect("Azure subscriptions" in out and "Power Platform environments" in out, "wizard lists subscriptions and environments")
    expect(summary["subscriptionId"] == "33333333-3333-3333-3333-333333333333" and summary["environments"] == ["dev"], f"wizard answers used: {summary.get('subscriptionId')}")
    expect(opt(find(pac, "connector", "create")[0], "--environment") == "https://platform.crm.dynamics.com", "second environment chosen")
print(f"OK   {name}")
