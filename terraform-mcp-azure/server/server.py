"""Azure Terraform MCP server - entry point.

  python server.py                 serve MCP over streamable HTTP on :8080/mcp
  python server.py job reaper      destroy expired time-boxed deployments (scheduled Container Apps Job)
  python server.py job drift       drift-check every deployment            (scheduled Container Apps Job)
  python server.py job recover     recover operations whose worker died    (also done by every replica)

All logic lives in the ``tfmcp`` package; this file only wires Azure, Terraform and MCP together.
"""
from __future__ import annotations

import functools
import json
import os
import sys
import time

import anyio

from tfmcp import __version__
from tfmcp.audit import AuditLog
from tfmcp.catalog import Catalog
from tfmcp.config import Settings
from tfmcp.cost import CostEstimator, PriceClient
from tfmcp.identity import (Authenticator, IdentityMiddleware, JwtValidator, current_identity, reset_identity,
                            set_identity, system_identity)
from tfmcp.operations import OperationEngine
from tfmcp.policy import PolicyEngine
from tfmcp.service import Service, ToolError
from tfmcp.storage import BlobStore, MemoryStore
from tfmcp.terraform import TerraformRunner


def build(settings: Settings, *, data=None, state=None, audit_store=None, tf=None, price_fetch=None):
    """Wire the service. Stores / runner / price fetcher can be injected (tests, local runs)."""
    tf_env = {"ARM_USE_MSI": "true", "ARM_SUBSCRIPTION_ID": settings.subscription_id, "ARM_TENANT_ID": settings.tenant_id}
    if os.environ.get("AZURE_CLIENT_ID"):
        tf_env["ARM_CLIENT_ID"] = os.environ["AZURE_CLIENT_ID"]   # user-assigned managed identity
    audit_boot = AuditLog(None)
    if data is None:
        if settings.store_mode == "memory":
            data, state, audit_store = MemoryStore(), MemoryStore(), MemoryStore()
            audit_boot.emit({"type": "startup_warning", "message": "STORE_MODE=memory: nothing is persisted. Local testing only."})
        else:
            from azure.identity import DefaultAzureCredential

            cred = DefaultAzureCredential()
            data = BlobStore.from_account(settings.state_account, "plans", cred)
            state = BlobStore.from_account(settings.state_account, "tfstate", cred)
            audit_store = BlobStore.from_account(settings.state_account, "audit", cred)
            mode = os.environ.get("TOKEN_BROKER", "auto").lower()
            if mode == "on" or (mode == "auto" and os.environ.get("IDENTITY_ENDPOINT")):
                from tfmcp.tokenbroker import TokenBroker

                def get_token(scope: str):
                    t = cred.get_token(scope)
                    return t.token, t.expires_on
                broker = TokenBroker(get_token, on_error=lambda m: audit_boot.emit({"type": "token_broker_error", "error": m}))
                tf_env["ARM_MSI_ENDPOINT"] = broker.start()
    audit = AuditLog(audit_store)
    engine = OperationEngine(data, state_store=state, lease_seconds=settings.lease_seconds,
                             heartbeat_seconds=settings.heartbeat_seconds, max_workers=settings.max_concurrent_ops,
                             max_attempts=settings.max_plan_attempts, log=audit.emit)
    notify = None
    if settings.notify_webhook_url:
        def notify(event: dict) -> None:
            if event.get("text"):
                import httpx
                httpx.post(settings.notify_webhook_url, json={"text": event["text"], "event": event}, timeout=5.0)
    service = Service(settings, data=data, state=state, audit=audit, catalog=Catalog(settings.template_dir),
                      policy=PolicyEngine.from_file(settings.policy_file),
                      cost=CostEstimator(PriceClient(cache=data, fetch=price_fetch, ttl_hours=settings.price_cache_hours),
                                         enabled=settings.cost_enabled),
                      tf=tf or TerraformRunner(os.environ.get("TERRAFORM_BIN", "terraform"), tf_env), engine=engine, notify=notify)
    return service, engine, audit


def create_mcp(svc: Service, audit: AuditLog, settings: Settings):
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("azure-terraform", host=settings.host, port=settings.port, stateless_http=True, json_response=True,
                  instructions=("Governed Terraform for Azure. Always plan first, read the plan's explanation.read_to_user to "
                                "the user, and call apply_plan only after the user explicitly confirms. Long operations "
                                "return an operation_id: poll get_operation."))

    def tool(fn):
        """Register ``fn`` as an MCP tool: run it off the event loop, with identity and an audit record."""
        @functools.wraps(fn)
        async def wrapper(**kwargs):
            identity = current_identity()

            def call():
                token = set_identity(identity)
                started = time.monotonic()
                args = {k: v for k, v in kwargs.items() if v is not None}
                try:
                    result = fn(**kwargs)
                except ToolError as e:
                    audit.record(identity, fn.__name__, args, e.kind, error=str(e), duration_ms=(time.monotonic() - started) * 1000)
                    raise
                except Exception as e:  # noqa: BLE001
                    event = audit.record(identity, fn.__name__, args, "error", error=f"{type(e).__name__}: {e}",
                                         duration_ms=(time.monotonic() - started) * 1000)
                    raise RuntimeError(f"Internal error. Give this reference to your platform team: {event['audit_id']}") from None
                finally:
                    reset_identity(token)
                extra = {}
                if isinstance(result, dict):
                    for k in ("operation_id", "plan_id"):
                        if isinstance(result.get(k), str):
                            extra["result_" + k] = result[k]
                    if isinstance(result.get("result"), dict) and isinstance(result["result"].get("plan_id"), str):
                        extra["result_plan_id"] = result["result"]["plan_id"]
                audit.record(identity, fn.__name__, args, "ok", duration_ms=(time.monotonic() - started) * 1000, extra=extra)
                return result
            return await anyio.to_thread.run_sync(call)
        return mcp.tool()(wrapper)

    @tool
    def whoami() -> dict:
        """Show which Entra ID user this session is acting as (used for audit and approvals)."""
        return svc.whoami(current_identity())

    @tool
    def list_environments() -> dict:
        """List the environments (for example dev, test, prod) with their rules: allowed regions, whether apply and
        destroy are enabled, whether a second person must approve, budget cap, policy rules and time-box limits."""
        return svc.list_environments()

    @tool
    def list_templates(environment: str | None = None, category: str | None = None) -> dict:
        """List the approved infrastructure templates and a one-line signature of every variable. Only these
        templates can be deployed. Call describe_template for the full schema of one template."""
        return svc.list_templates(environment, category)

    @tool
    def describe_template(template: str, environment: str | None = None) -> dict:
        """Full typed variable schema (types, allowed values, ranges, defaults, descriptions), security defaults and
        outputs of one template. Use it before plan_deployment and never invent variables."""
        return svc.describe_template(template, environment)

    @tool
    def plan_deployment(template: str, deployment_name: str, variables: dict | None = None, environment: str | None = None,
                        location: str | None = None, tags: dict | None = None, ttl_hours: float | None = None) -> dict:
        """Plan creating or updating a deployment from an approved template. Nothing is changed. Returns an operation
        whose result holds the plan_id, a plain-English explanation (explanation.read_to_user), risk level, policy
        results, a monthly cost estimate and whether approval is needed. ttl_hours makes a NEW deployment time-boxed:
        it is destroyed automatically after that many hours (only where the environment allows it)."""
        return svc.plan_deployment(current_identity(), template, deployment_name, variables, environment, location, tags, ttl_hours)

    @tool
    def plan_destroy(deployment_name: str, environment: str | None = None) -> dict:
        """Plan the complete removal of a deployment. Nothing is deleted until apply_plan. Irreversible once applied."""
        return svc.plan_destroy(current_identity(), deployment_name, environment)

    @tool
    def plan_rollback(deployment_name: str, environment: str | None = None) -> dict:
        """Plan a return to the inputs of the previous successful apply of this deployment (an 'undo' of the last
        change). Nothing is changed until apply_plan."""
        return svc.plan_rollback(current_identity(), deployment_name, environment)

    @tool
    def explain_plan(plan_id: str) -> dict:
        """Explain a saved plan in plain English: what will be created, changed and destroyed, the risk level and why,
        the cost change, policy results, approval status and what has to happen next. Read explanation.read_to_user
        to the user."""
        return svc.explain_plan(plan_id)

    @tool
    def request_approval(plan_id: str, justification: str) -> dict:
        """Ask for a second person's approval of a plan in an environment that requires it (for example prod).
        Give a justification: what changes and why."""
        return svc.request_approval(current_identity(), plan_id, justification)

    @tool
    def approve_plan(plan_id: str, comment: str | None = None) -> dict:
        """Approve a pending plan as the signed-in user. The person who created or requested the plan cannot approve it
        (two-person rule). Review it with explain_plan first."""
        return svc.approve_plan(current_identity(), plan_id, comment or "")

    @tool
    def reject_plan(plan_id: str, reason: str | None = None) -> dict:
        """Reject a pending plan (or withdraw your own request)."""
        return svc.reject_plan(current_identity(), plan_id, reason or "")

    @tool
    def list_pending_approvals(environment: str | None = None) -> dict:
        """List plans that are waiting for approval."""
        return svc.list_pending_approvals(environment)

    @tool
    def apply_plan(plan_id: str) -> dict:
        """Apply a saved plan. ONLY call after the user has seen the explanation and explicitly confirmed. Refused if
        the plan violates policy, is over budget, has expired, or lacks a required approval."""
        return svc.apply_plan(current_identity(), plan_id)

    @tool
    def get_operation(operation_id: str) -> dict:
        """Check a long-running plan, apply or drift check. Poll about every 20 seconds until status is succeeded,
        failed or interrupted."""
        return svc.get_operation(operation_id)

    @tool
    def list_deployments(environment: str | None = None) -> dict:
        """List what has been deployed: template, owner, status, cost estimate, drift status and - for time-boxed
        deployments - when they expire."""
        return svc.list_deployments(environment)

    @tool
    def get_deployment(deployment_name: str, environment: str | None = None) -> dict:
        """Details of one deployment: inputs, outputs, Azure resources, change history (who planned, approved and
        applied each change) and the last drift result."""
        return svc.get_deployment(deployment_name, environment)

    @tool
    def detect_drift(deployment_name: str | None = None, environment: str | None = None) -> dict:
        """Check whether Azure still matches what was deployed (someone changed or deleted a resource outside
        Terraform). Read-only. Omit deployment_name to check every deployment in the environment."""
        return svc.detect_drift(current_identity(), deployment_name, environment)

    @tool
    def extend_ttl(deployment_name: str, hours: float, environment: str | None = None) -> dict:
        """Keep a time-boxed deployment alive longer by the given number of hours (within the environment's limit)."""
        return svc.extend_ttl(current_identity(), deployment_name, hours, environment)

    return mcp


def create_app(svc: Service, audit: AuditLog, settings: Settings):
    mcp = create_mcp(svc, audit, settings)
    validator = None
    if settings.auth_mode == "jwt":
        validator = JwtValidator(settings.tenant_id, settings.api_audiences)
    auth = Authenticator(settings.auth_mode, validator)
    return IdentityMiddleware(mcp.streamable_http_app(), auth,
                              on_reject=lambda path, why: audit.emit({"type": "auth_rejected", "path": path, "reason": why}))


def run_job(name: str, svc: Service, engine: OperationEngine) -> int:
    engine.tick()   # recover anything a dead worker left behind before doing new work
    if name == "reaper":
        token = set_identity(system_identity("ttl-reaper"))
        report = svc.run_reaper(system_identity("ttl-reaper"))
    elif name == "drift":
        token = set_identity(system_identity("drift-scan"))
        report = svc.run_drift_scan(system_identity("drift-scan"))
    elif name == "recover":
        token = set_identity(system_identity("recover"))
        report = engine.tick()
    else:
        print("unknown job; use: reaper | drift | recover", file=sys.stderr)
        return 2
    reset_identity(token)
    print(json.dumps({"type": "job_report", "job": name, "report": report}, default=str), flush=True)
    return 1 if isinstance(report, dict) and report.get("failed") else 0


def main(argv: list[str]) -> int:
    settings = Settings.from_env()
    svc, engine, audit = build(settings)
    if len(argv) >= 2 and argv[0] == "job":
        return run_job(argv[1], svc, engine)
    import uvicorn

    app = create_app(svc, audit, settings)
    engine.start()
    audit.emit({"type": "startup", "version": __version__, "auth_mode": settings.auth_mode, "worker": engine.owner,
                "environments": sorted(settings.environments), "templates": len(svc.catalog.names())})
    # uvicorn handles SIGTERM/SIGINT itself and then RE-RAISES the signal with the previous handler. Install
    # no-op handlers first, otherwise the process dies before the graceful Terraform shutdown below runs.
    import signal

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda signum, frame: None)
    try:
        uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", access_log=False)
    finally:
        # SIGTERM (scale-in, new revision): stop Terraform gracefully so state is written and unlocked
        engine.shutdown(grace_seconds=float(os.environ.get("SHUTDOWN_GRACE_SECONDS", "100")))
        audit.emit({"type": "shutdown", "worker": engine.owner})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
