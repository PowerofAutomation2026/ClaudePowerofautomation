# Threat model - Azure Terraform MCP v2.1

Design review by the authors. Not a penetration test; nothing here was exercised on a live tenant.
No system is unhackable: this document says which control stops which attack, and what remains.

## Assumptions
* **The agent is hostile.** The LLM / Copilot Studio agent may be prompt-injected or jailbroken. It can call
  every MCP tool with any arguments, as whichever user is signed in, and it can lie about what the user said.
  Agent instructions are not a control.
* **A user's MCP bearer token may be stolen** and replayed from anywhere until it expires.
* Entra ID, the Azure control plane, and the people who are Owner of the subscriptions are trusted.

## Assets
1. The Azure environments (especially production data resources). 2. Terraform state (contains whatever the
provider stores, including some secrets). 3. The decision trail (who planned, approved, applied).
4. Availability of the service.

## Trust boundaries
```
 user ─ chat ─> AGENT (untrusted) ─ token aud=MCP ─> [ MCP front-end ]  read-only identity
                                                         │ can write: plans, operations, its own audit lines
                                                         │ can read : state, control (approvals, freeze, quotas)
                                                         ▼ queue
 approver ─ browser, fresh sign-in, token aud=APPROVAL ─> [ approval service + executor ]  write identity
                                                         │ only writer of: control container, Azure resources
                                                         ▼
                                        Azure Resource Manager  ◄─ locks, policy, custom-role exclusions
```
The two services share an image and a storage account but not an identity, not a token audience, and not the
`control` container's write permission.

## Attacker scenarios

### A. Prompt-injected / jailbroken agent
| Goal | What stops it | Residual |
|---|---|---|
| Apply or destroy without consent | No MCP tool can approve. `apply` is refused unless the trusted control store holds an unused, unexpired approval for that exact plan file, created on the approval channel with a different token audience. "The user said yes" is not an input anywhere. | The agent can *ask* a human to approve something misleading (social engineering). The approval page shows the server's own summary, risk, cost and policy result, not the agent's words. |
| Destroy infrastructure | Destroy plans need owner/admin + the same out-of-band approval; protected deployments are refused at plan, approval and execution; quota on deletions per day; in locked environments the apply role cannot delete data resources and the resource group has a CanNotDelete lock. | A human approver who approves a real destroy of an unprotected deployment in an unlocked environment. |
| Deploy something dangerous | Curated templates, typed/pattern-validated inputs, policy gate at plan, at approval and on the real plan file at execution; budget cap; approved SKU/region lists. | Whatever the templates and policy allow, an approver can approve. |
| Flood / exhaust | Per-user call and plan limits, global apply quota, anomaly auto-freeze. | It can trip the auto-freeze on purpose: a denial of service that needs an admin to lift. Chosen deliberately: fail closed. |
| Read other teams' data | Per-user visibility; only viewers/admins see everything. | Users with the viewer role see all deployments and outputs (outputs marked sensitive are masked). |
| Inject instructions through tool results | Resource names, tags, errors and comments are stripped of control characters, secret-like values and instruction-like phrases and are length-capped before they go back. | Pattern-based; a determined injection can evade a filter. It does not matter for integrity because no tool result can grant an approval. |

### B. Stolen MCP user token
| Goal | What stops it | Residual |
|---|---|---|
| Use it against the approval channel | Wrong audience, wrong client id, wrong scope: rejected (tested). | - |
| Use it against MCP | Works until it expires for reads and plans as that user (their role, their deployments). Writes need a token younger than 75 minutes. `azp` allow-list: only tokens issued to the connector app. Optional IP allow-list / Conditional Access (documented). | The thief can read what the user can read, create plans and approval requests. Nothing is applied without a human on the approval page. |

### C. Stolen approver session / approval token
Needs a token for the approval audience from a sign-in in the last 10 minutes (`auth_time`), optionally with
an MFA claim; Conditional Access on the approval app (recommended: MFA + sign-in frequency "every time",
compliant device) is the real control. Two-person rule still requires a *different* requester. Approvals expire
in 30 minutes and are single use. **Residual:** an attacker who controls both an approver's fresh session and a
requester can change what policy, quotas, locks and custom-role exclusions allow - not more.

### D. Malicious template variable / parameter tampering
Values are validated against the template schema (types, enums, ranges, regex, resource-id formats) and passed
as JSON variable values - never interpolated into HCL, a shell or a file path. Terraform is started without a
shell (argument vector). Deployment, plan, operation and template names are strictly validated before being
used in blob keys or the state key. Injected variables (subscription, resource group, tags) cannot be
overridden. Tested with traversal, shell, HCL and type-confusion payloads. **Residual:** a logic flaw in a
template.

### E. Compromised MCP front-end container (code execution)
It holds a read-only Azure identity: it cannot create, change or delete resources. It can write the `plans`
container, so it can forge plan metadata, queue applies and tamper deployment records - therefore the executor
trusts none of that: it reads approvals only from `control` (front-end: read-only), recomputes the changes from
the binary plan with `terraform show`, compares them with the digest the approver saw, re-runs policy, and
checks protection and quotas in `control`. Tested: forged approval, swapped plan file, plan JSON that lies.
**Residual:** it can read Terraform state (secrets the providers store there) and everything the read-only role
can read; it can delete its own auto-freeze flag (not the admin freeze), corrupt its own records (availability,
misleading listings) and stop writing audit lines. It could show a misleading summary to the *requester*, but
not to the approver, whose page is rendered by the other service.

### F. Compromised approval/executor container
This is the crown jewel: it can write approvals and holds the apply identity. Limits that do not depend on our
code: custom role (no Microsoft.Authorization writes, so no role assignments, no lock removal, no policy
exemptions; no resource-group delete; in locked environments no deletion of data resource types), CanNotDelete
locks, deny-delete policy, scope limited to the environment resource groups. Smaller surface: no MCP endpoint,
no agent input except plan data, optional IP allow-list. **Residual:** within those limits it can create and
modify resources and delete non-protected ones in unlocked environments.

### G. Insider (requester or approver)
Two-person rule, role separation (requester vs approver are different app roles on different apps), immutable
audit, alerts on destroy requested/approved/applied, on odd-hour and self approvals, on refused approval
attempts, on lock / role / policy changes in the Activity Log. **Residual:** collusion of two insiders; an
Owner of the subscription can do anything (outside this system's scope).

### H. Supply chain
Base image pinned by digest; Terraform and provider archives verified against published SHA-256; provider lock
file enforced read-only; providers served only from the image; Python dependencies exact-pinned; templates and
policies verified against `integrity.json` at build and at every start. **Residual:** trust in upstream
publishers at pin time; no image signing/SBOM/scanning in this package; the approval page loads MSAL from
Microsoft's CDN (pinned version, no subresource-integrity hash).

### I. The unauthenticated OAuth facade (v2.3, `-ConnectorAuth dynamic`)
| Attack | What stops it | Residual |
|---|---|---|
| Open redirect / phishing through `/authorize` | Redirects only to the fixed Entra authorize URL of the tenant; `redirect_uri` must exactly equal an allow-listed value; errors are answered directly, never by redirect. | A link to our `/authorize` leads to the genuine Entra sign-in for the genuine connector app - as any OAuth client's link does. |
| Register a malicious client / redirect | `/register` creates nothing: it returns the one pre-registered client and refuses any redirect URI not on the allow-list. | - |
| Authorization-code interception | PKCE S256 required by the facade and enforced by Entra; codes are single use at Entra; redirect URI must match. | Compromise of Copilot Studio's redirect endpoint itself. |
| Use `/token` as a confidential-client oracle | Needs a valid code for the connector app and allowed redirect URI plus its PKCE verifier; scope is forced; only two grant types; rate limited. | Whoever legitimately completes a sign-in gets a token for themselves - intended. Refresh tokens presented to `/token` are exchanged; a stolen refresh token is as dangerous as with any OAuth client. |
| Host-header spoofing to poison metadata | All URLs come from `PUBLIC_BASE_URL`. | Mis-set configuration. |
| SSRF | No user-supplied URL is ever fetched; upstream URL is fixed; no redirects followed. | - |
| Secret leak | Never returned, never logged; registered with the log scrubber; held as a Container Apps secret. | Readable by code running in the front-end container. |
| Flooding | Per-address rate limits, body cap, small in-memory state. | Addresses can be rotated; add an IP allow-list or a WAF if needed. |
| Bypass of `/mcp` protection now that Easy Auth allows anonymous | The server validates every request itself; tests assert 401 for every method without a valid token. | One layer instead of two for the MCP endpoint (use manual mode to keep Easy Auth in front). |

## STRIDE summary
| | Main controls |
|---|---|
| Spoofing | JWT validation per channel (audience, issuer, tenant, signature, expiry), client-app allow-list, required scope, fresh sign-in for approval, app-only tokens refused |
| Tampering | Out-of-band approval bound to file hash + change digest, trusted control store, executor re-derivation, integrity manifest, state versioning |
| Repudiation | Per-call audit with Entra identity on both channels, WORM audit container, Log Analytics, deployment history |
| Information disclosure | Per-user visibility, output/plan redaction, secret scrubbing in results and logs, no secrets in settings |
| Denial of service | Rate limits, quotas, concurrency limits, kill switch (which is itself a DoS lever by design) |
| Elevation of privilege | Split identities, custom roles without authorization rights, locks, deny policy, RBAC per tool, protected deployments |

## Known residual risks (short list)
1. A person approves something they should not. The system can inform and slow them, not replace judgement.
2. Terraform state is readable by the front-end identity.
3. The time-box reaper destroys without a fresh approval (agreed at creation, shown on the approval page then).
4. Self-approval environments are one stolen approval-audience session away from an apply (use only for dev).
5. Output filtering against prompt injection is heuristic.
6. Controls were verified with emulators and fakes only; real Entra claims, role and lock behaviour must be
   confirmed in a sandbox before relying on them.
