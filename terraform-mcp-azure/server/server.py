"""Terraform-on-Azure MCP server.
Runs Terraform inside the container using the Container App's managed identity (no HCP Terraform needed).
Guardrails: curated templates only, fixed resource group, plan-then-apply with a saved plan, apply/destroy off by default."""
import json, os, pathlib, re, shutil, subprocess, tempfile, threading, time, uuid
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from mcp.server.fastmcp import FastMCP

SUB   = os.environ["SUBSCRIPTION_ID"]
TENANT = os.environ.get("TENANT_ID", "")
RG    = os.environ["WORKLOAD_RG"]
SA    = os.environ["STATE_SA"]
LOC_OK = [x.strip() for x in os.environ.get("ALLOWED_LOCATIONS", "eastus2").split(",") if x.strip()]
APPLY_OK   = os.environ.get("ENABLE_APPLY", "false").lower() == "true"
DESTROY_OK = os.environ.get("ENABLE_DESTROY", "false").lower() == "true"
TEMPLATES = pathlib.Path(os.environ.get("TEMPLATE_DIR", "/app/templates"))
PLAN_TTL = 3600
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$")

blobs = BlobServiceClient(f"https://{SA}.blob.core.windows.net", credential=DefaultAzureCredential())
state_c, plans_c = blobs.get_container_client("tfstate"), blobs.get_container_client("plans")
mcp = FastMCP("azure-terraform", host="0.0.0.0", port=8080, stateless_http=True, json_response=True)
OPS: dict = {}

def _templates():
    return {p.name: json.loads((p / "template.json").read_text()) for p in sorted(TEMPLATES.iterdir())
            if p.is_dir() and not p.name.startswith("_")}

def _tf(args, cwd, timeout=3000):
    env = {**os.environ, "ARM_USE_MSI": "true", "ARM_SUBSCRIPTION_ID": SUB, "ARM_TENANT_ID": TENANT}
    r = subprocess.run(["terraform", *args, "-no-color"], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr)

def _prepare(template, deployment, variables, workdir):
    shutil.copytree(TEMPLATES / template, workdir, dirs_exist_ok=True)
    shutil.copy(TEMPLATES / "_common" / "common.tf", workdir / "common.tf")
    (workdir / "terraform.tfvars.json").write_text(json.dumps(variables))
    code, out = _tf(["init", "-reconfigure", f"-backend-config=storage_account_name={SA}", "-backend-config=container_name=tfstate",
                     f"-backend-config=key={deployment}.tfstate", "-backend-config=use_azuread_auth=true",
                     "-backend-config=use_msi=true", f"-backend-config=subscription_id={SUB}"], workdir)
    if code: raise RuntimeError("terraform init failed:\n" + out[-3000:])

def _validate(template, deployment, variables):
    tpls = _templates()
    if template not in tpls: raise ValueError(f"Unknown template. Choose from: {list(tpls)}")
    if not NAME_RE.match(deployment): raise ValueError("deployment_name must be 3-24 chars: lowercase letters, digits, hyphens")
    allowed = set(tpls[template]["variables"]) | {"location"}
    bad = set(variables) - allowed
    if bad: raise ValueError(f"Unsupported variables {sorted(bad)}. Allowed: {sorted(allowed)}")
    loc = variables.get("location", LOC_OK[0])
    if loc not in LOC_OK: raise ValueError(f"location must be one of {LOC_OK}")
    return {**variables, "location": loc, "subscription_id": SUB, "deployment_name": deployment, "resource_group_name": RG,
            "tags": {"managedBy": "azure-terraform-mcp", "deployment": deployment}}

def _run(op_id, fn, wait=75):
    OPS[op_id] = {"operation_id": op_id, "status": "running", "started": time.time()}
    def work():
        try: OPS[op_id].update(status="succeeded", result=fn())
        except Exception as e: OPS[op_id].update(status="failed", error=str(e)[-3000:])
        plans_c.upload_blob(f"ops/{op_id}.json", json.dumps(OPS[op_id], default=str), overwrite=True)
    t = threading.Thread(target=work, daemon=True); t.start(); t.join(wait)
    return OPS[op_id] if OPS[op_id]["status"] != "running" else {**OPS[op_id], "note": "Still running - call get_operation with this operation_id in ~30s."}

def _plan_job(plan_id, template, deployment, variables, destroy):
    def job():
        with tempfile.TemporaryDirectory() as d:
            wd = pathlib.Path(d); _prepare(template, deployment, variables, wd)
            code, out = _tf(["plan", "-out=tfplan", "-detailed-exitcode"] + (["-destroy"] if destroy else []), wd)
            if code == 1: raise RuntimeError(out[-3000:])
            changes = code == 2
            _, shown = _tf(["show", "tfplan"], wd)
            if changes:
                for n in ("tfplan",): plans_c.upload_blob(f"plans/{plan_id}/{n}", (wd / n).read_bytes(), overwrite=True)
                plans_c.upload_blob(f"plans/{plan_id}/meta.json", json.dumps(dict(template=template, deployment=deployment,
                    variables=variables, destroy=destroy, created=time.time())), overwrite=True)
            return {"plan_id": plan_id if changes else None, "has_changes": changes, "destroy": destroy,
                    "summary": shown[-6000:], "next": f"Show this to the user. To execute, call apply_plan('{plan_id}') after the user explicitly confirms." if changes else "No changes."}
    return job

@mcp.tool()
def list_templates() -> dict:
    """List the approved infrastructure templates and the variables each accepts."""
    return {"resource_group": RG, "allowed_locations": LOC_OK, "apply_enabled": APPLY_OK, "destroy_enabled": DESTROY_OK, "templates": _templates()}

@mcp.tool()
def plan_deployment(template: str, deployment_name: str, variables: dict | None = None) -> dict:
    """Create (or update) an Azure deployment from an approved template: runs `terraform plan` and returns a plan_id. Nothing is changed until apply_plan."""
    v = _validate(template, deployment_name, variables or {}); pid = uuid.uuid4().hex[:12]
    return _run(pid, _plan_job(pid, template, deployment_name, v, False))

@mcp.tool()
def plan_destroy(deployment_name: str) -> dict:
    """Plan the destruction of an existing deployment. Requires the destroy feature; nothing is deleted until apply_plan."""
    if not DESTROY_OK: raise PermissionError("Destroy is disabled on this server (ENABLE_DESTROY=false).")
    if not NAME_RE.match(deployment_name): raise ValueError("bad deployment_name")
    if not any(b.name == f"{deployment_name}.tfstate" for b in state_c.list_blobs()): raise ValueError("No such deployment")
    meta = json.loads(plans_c.download_blob(f"deployments/{deployment_name}.json").readall())
    pid = uuid.uuid4().hex[:12]
    return _run(pid, _plan_job(pid, meta["template"], deployment_name, meta["variables"], True))

@mcp.tool()
def apply_plan(plan_id: str) -> dict:
    """Apply a previously created plan. ONLY call after the user has reviewed the plan summary and explicitly confirmed."""
    if not re.fullmatch(r"[0-9a-f]{12}", plan_id): raise ValueError("bad plan_id")
    meta = json.loads(plans_c.download_blob(f"plans/{plan_id}/meta.json").readall())
    if meta["destroy"] and not DESTROY_OK: raise PermissionError("Destroy is disabled on this server.")
    if not meta["destroy"] and not APPLY_OK: raise PermissionError("Apply is disabled on this server (ENABLE_APPLY=false). Plans are read-only.")
    if time.time() - meta["created"] > PLAN_TTL: raise ValueError("Plan expired (1h). Run the plan again.")
    def job():
        with tempfile.TemporaryDirectory() as d:
            wd = pathlib.Path(d); _prepare(meta["template"], meta["deployment"], meta["variables"], wd)
            (wd / "tfplan").write_bytes(plans_c.download_blob(f"plans/{plan_id}/tfplan").readall())
            code, out = _tf(["apply", "-auto-approve", "tfplan"], wd)
            if code: raise RuntimeError(out[-3000:])
            if meta["destroy"]: plans_c.delete_blob(f"deployments/{meta['deployment']}.json")
            else: plans_c.upload_blob(f"deployments/{meta['deployment']}.json", json.dumps({"template": meta["template"], "variables": meta["variables"]}), overwrite=True)
            for b in plans_c.list_blobs(name_starts_with=f"plans/{plan_id}/"): plans_c.delete_blob(b.name)
            _, o = _tf(["output", "-json"], wd)
            return {"applied": True, "destroyed": meta["destroy"], "outputs": o[-3000:], "log_tail": out[-1500:]}
    return _run(uuid.uuid4().hex[:12], job)

@mcp.tool()
def get_operation(operation_id: str) -> dict:
    """Check a long-running plan/apply by operation_id."""
    if not re.fullmatch(r"[0-9a-f]{12}", operation_id): raise ValueError("bad operation_id")
    if operation_id in OPS: return OPS[operation_id]
    return json.loads(plans_c.download_blob(f"ops/{operation_id}.json").readall())

@mcp.tool()
def list_deployments() -> list:
    """List deployments managed by this server and the Azure resources in each (from Terraform state)."""
    out = []
    for b in state_c.list_blobs():
        if not b.name.endswith(".tfstate"): continue
        s = json.loads(state_c.download_blob(b.name).readall() or b"{}")
        out.append({"deployment": b.name[:-8], "resources": [f"{r['type']}.{r['name']}" for r in s.get("resources", [])]})
    return out

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
