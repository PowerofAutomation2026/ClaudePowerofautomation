"""The out-of-band approval channel: a small web page + JSON API, served by the PRIVILEGED process on
its own host name. It is deliberately not part of the MCP tool surface.

* Tokens must be issued for the *approval* audience (a separate Entra app registration), to the
  approval page's own client id, with the ``approve`` scope. The MCP connector's token is rejected.
* The sign-in must be fresh (``auth_time``/``iat``), optionally with MFA / an authentication context.
* API (bearer token in the Authorization header, so there is no cookie to forge requests with):
    GET  /api/pending                      plans waiting for a decision
    GET  /api/plans/{id}                   what exactly would happen (summary, risk, cost, policy, digest)
    POST /api/plans/{id}/decision          {"decision": "approve"|"reject", "comment": "...", "digest": "..."}
    GET  /api/freeze, POST /api/freeze     kill switch (admin role): {"frozen": true|false, "reason": "..."}
"""
from __future__ import annotations

import html
import json
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .approvals import ApprovalError, ApprovalService
from .audit import AuditLog
from .guard import Guard
from .identity import AuthError, Authenticator
from .sanitize import deep_clean

SECURITY_HEADERS = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' https://alcdn.msauth.net; style-src 'unsafe-inline'; "
                               "connect-src 'self' https://login.microsoftonline.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Strict-Transport-Security": "max-age=31536000",
}

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approve infrastructure change</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#111}
.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.bad{color:#b00020;font-weight:600}
.risk-high,.risk-critical{color:#b00020}.destroy{background:#fde7e9;border-color:#b00020}
button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}pre{white-space:pre-wrap}textarea{width:100%;height:4rem}</style>
<script src="https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js"></script></head>
<body><h1>Approve infrastructure change</h1>
<p>You are deciding with <b>your own, freshly signed-in account</b>. This page is the only place a plan can be approved;
the chat agent cannot approve anything. Read the change below before you decide.</p>
<div id="app">Signing in...</div>
<script id="cfg" type="application/json">__CONFIG__</script><script src="/app.js"></script></body></html>"""

APP_JS = r"""
const cfg = JSON.parse(document.getElementById('cfg').textContent), app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msalApp = new msal.PublicClientApplication({auth: {clientId: cfg.clientId, authority: cfg.authority, redirectUri: location.origin + '/'},
  cache: {cacheLocation: 'sessionStorage'}});
let token = null;
async function signIn() {
  const r = await msalApp.handleRedirectPromise();
  if (r && r.accessToken) { token = r.accessToken; history.replaceState(null, '', sessionStorage.getItem('back') || '/'); return; }
  sessionStorage.setItem('back', location.pathname + location.search);
  // prompt=login + max_age=0: always a fresh interactive sign-in, never a silent one
  await msalApp.acquireTokenRedirect({scopes: [cfg.scope], prompt: 'login', extraQueryParameters: {max_age: '0'}});
}
async function api(path, body) {
  const r = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
async function showList() {
  const d = await api('/api/pending');
  app.innerHTML = '<h2>Waiting for a decision</h2>' + (d.pending.length ? d.pending.map(p =>
    `<div class="card"><a href="/?plan=${esc(p.plan_id)}">${esc(p.destroy ? 'DESTROY' : 'Apply')} ${esc(p.deployment)} in ${esc(p.environment)}</a>
     - requested by ${esc(p.requested_by)}</div>`).join('') : '<p>Nothing is waiting.</p>');
}
async function showPlan(id) {
  const p = await api('/api/plans/' + encodeURIComponent(id));
  app.innerHTML = `<div class="card ${p.destroy ? 'destroy' : ''}"><h2>${esc(p.headline)}</h2>
   <p>Requested by <b>${esc(p.requested_by)}</b>: ${esc(p.justification)}</p>
   <p class="risk-${esc(p.risk_level)}">Risk: <b>${esc(p.risk_level).toUpperCase()}</b> - ${esc((p.risk_reasons || []).join(' '))}</p>
   <ul>${(p.changes || []).map(c => `<li>${esc(c.text)}</li>`).join('')}</ul>
   <p>${esc(p.cost_summary)}</p>
   ${(p.policy_violations || []).map(v => `<p class="bad">Policy: ${esc(v)}</p>`).join('')}
   ${(p.policy_warnings || []).map(v => `<p>Warning: ${esc(v)}</p>`).join('')}
   ${p.ephemeral ? `<p><b>Time-boxed:</b> will be destroyed automatically after ${esc(p.ephemeral.ttl_hours)} hours without another approval.</p>` : ''}
   <p>Plan ${esc(p.plan_id)}, expires ${esc(p.plan_expires_at)}. Status: ${esc(p.status)}. Signed in as ${esc(p.you)}.</p>
   ${p.you_may_decide && p.status === 'pending' ? `<textarea id="c" placeholder="Comment (optional)"></textarea>
     <p><button id="ok">Approve exactly this</button><button id="no">Reject</button></p>` : '<p><b>You cannot decide this plan.</b></p>'}</div>`;
  const decide = async decision => { try { const r = await api('/api/plans/' + encodeURIComponent(id) + '/decision',
      {decision, comment: document.getElementById('c').value, digest: p.changes_digest});
      app.innerHTML = `<div class="card"><h2>${esc(r.status)}</h2><p>You can close this page.</p></div>`; }
    catch (e) { alert(e.message); } };
  if (document.getElementById('ok')) { document.getElementById('ok').onclick = () => decide('approve'); document.getElementById('no').onclick = () => decide('reject'); }
}
(async () => { try { await msalApp.initialize(); await signIn(); if (!token) return;
  const id = new URLSearchParams(location.search).get('plan'); await (id ? showPlan(id) : showList()); }
  catch (e) { app.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; } })();
"""


def create_approval_app(approvals: ApprovalService, guard: Guard, audit: AuditLog, authenticator: Authenticator,
                        *, tenant_id: str, client_id: str, scope: str) -> Starlette:
    config = json.dumps({"clientId": client_id, "authority": f"https://login.microsoftonline.com/{tenant_id}", "scope": scope})

    def reply(body, status: int = 200) -> JSONResponse:
        return JSONResponse(deep_clean(body), status_code=status, headers=SECURITY_HEADERS)

    async def run(request: Request, action: str, fn):
        started = time.monotonic()
        headers = {k.lower(): v for k, v in request.headers.items()}
        args = {"plan_id": request.path_params.get("plan_id")}
        try:
            identity = authenticator.authenticate(headers)
        except AuthError as e:
            audit.emit({"type": "auth_rejected", "path": request.url.path, "reason": str(e), "channel": "approval"})
            return reply({"error": "unauthorized: " + str(e)}, 401)
        try:
            result = await fn(identity)
        except ApprovalError as e:
            audit.record(identity, action, args, "denied", error=str(e), duration_ms=(time.monotonic() - started) * 1000,
                         extra={"channel": "approval"})
            return reply({"error": str(e)}, e.status)
        except Exception as e:  # noqa: BLE001
            event = audit.record(identity, action, args, "error", error=f"{type(e).__name__}: {e}", extra={"channel": "approval"})
            return reply({"error": f"internal error, reference {event['audit_id']}"}, 500)
        audit.record(identity, action, args, "ok", duration_ms=(time.monotonic() - started) * 1000, extra={"channel": "approval"})
        return reply(result)

    async def index(request: Request) -> Response:
        return HTMLResponse(PAGE.replace("__CONFIG__", html.escape(config, quote=False)), headers=SECURITY_HEADERS)

    async def app_js(request: Request) -> Response:
        return Response(APP_JS, media_type="application/javascript", headers=SECURITY_HEADERS)

    async def healthz(request: Request) -> Response:
        return JSONResponse({"status": "ok"})

    async def pending(request: Request):
        async def fn(identity):
            return {"pending": approvals.pending(identity)}
        return await run(request, "approval:pending", fn)

    async def plan(request: Request):
        async def fn(identity):
            return approvals.view(identity, request.path_params["plan_id"])
        return await run(request, "approval:view", fn)

    async def decision(request: Request):
        async def fn(identity):
            try:
                body = await request.json()
                choice = body["decision"]
                if choice not in ("approve", "reject") or not isinstance(body.get("digest", ""), str):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise ApprovalError('Body must be {"decision": "approve"|"reject", "comment": "...", "digest": "..."}', 400) from None
            return approvals.decide(identity, request.path_params["plan_id"], choice == "approve",
                                    str(body.get("comment") or ""), body.get("digest", ""))
        return await run(request, "approval:decide", fn)

    async def freeze(request: Request):
        async def fn(identity):
            approvals.check_caller(identity)
            if request.method == "GET":
                return {"frozen": guard.frozen(fresh=True)}
            if "admin" not in approvals._roles(identity):
                raise ApprovalError("Only an administrator can set or lift the freeze.", 403)
            try:
                body = await request.json()
                frozen, reason = body["frozen"], str(body.get("reason") or "")
                if not isinstance(frozen, bool) or len(reason.strip()) < 5:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise ApprovalError('Body must be {"frozen": true|false, "reason": "at least 5 characters"}', 400) from None
            return guard.set_freeze(frozen, identity, reason)
        return await run(request, "approval:freeze", fn)

    return Starlette(routes=[Route("/", index), Route("/app.js", app_js), Route("/healthz", healthz),
                             Route("/api/pending", pending), Route("/api/plans/{plan_id}", plan),
                             Route("/api/plans/{plan_id}/decision", decision, methods=["POST"]),
                             Route("/api/freeze", freeze, methods=["GET", "POST"])])
