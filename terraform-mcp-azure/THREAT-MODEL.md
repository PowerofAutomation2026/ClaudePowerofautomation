# Threat model (STRIDE-lite) - Azure Terraform MCP v2

Scope: the Azure-native server (`server/`), its deploy script and the Copilot Studio integration.
This is a design review by the authors, not a penetration test, and nothing here was verified on a live tenant.

## What we protect
1. **The Azure environments** the identity can change (the environment resource groups).
2. **Terraform state** (may contain secrets such as access keys) and saved plans.
3. **The integrity of the decision trail**: who planned, who approved, who applied.

## Trust boundaries
```
 user --(chat)--> Copilot Studio agent (LLM: untrusted decision maker)
                     | OAuth access token of the signed-in user
                     v
 [internet] --> Container Apps ingress + Easy Auth --> server --> terraform --> Azure Resource Manager
                                                        |                         (managed identity)
                                                        +--> blob storage (state, plans, operations, audit)
                                                        +--> prices.azure.com (read-only, public)
```
The LLM is treated as **untrusted**: it may be wrong or manipulated (prompt injection through a document or
a user). Therefore every control that matters is enforced by the server, not by the agent's instructions -
with one stated exception (T2).

## Threats and mitigations

| # | STRIDE | Threat | Mitigation | Residual risk |
|---|---|---|---|---|
| S1 | Spoofing | Anonymous or cross-tenant caller | Easy Auth returns 401 before the app; the server validates the bearer token again (signature via tenant JWKS, audience, issuer, tenant, expiry) in `AUTH_MODE=jwt`. Optional `-SecurityGroupId`, `-AllowedCidrs`. | Without `-SecurityGroupId` every user in the tenant who can sign in can call the tools (still bound by all guardrails). |
| S2 | Spoofing | Forged `X-MS-CLIENT-PRINCIPAL-*` headers to impersonate an approver | In `jwt` mode identity comes only from the validated token; those headers are ignored. | In `easyauth` mode the server trusts the platform to overwrite the headers. Prefer `jwt`. |
| S3 | Spoofing | One shared Copilot Studio connection makes every user the same identity | Documented requirement: end-user authentication. App-only tokens are flagged and cannot approve or apply in approval environments. | Configuration error on the Copilot Studio side cannot be detected by the server if a real user's connection is shared. |
| T1 | Tampering | Malicious input reaches Terraform (HCL injection, path tricks) | Only curated templates; inputs go in as JSON variable values (data, never code) after schema validation: types, enums, ranges, patterns, resource-ID formats. Injected variables (subscription, resource group, tags) cannot be overridden. IDs are strictly validated before use as blob keys. | A template with a flaw is a flaw for everyone: review templates like code. |
| T2 | Tampering | Agent applies without the user really confirming (prompt injection, over-eager model) | Apply needs a saved plan; policy, budget and expiry are enforced server-side; in approval environments a **second human** is enforced server-side. | In environments **without** approval, "the user confirmed" is an agent instruction, not a server control. Use plan-only or approval for anything that matters. |
| T3 | Tampering | Someone with write access to the storage account edits a plan, approval or operation record | Plan file checksum is verified at apply; policy is re-evaluated at apply; approval is bound to the plan checksum and approver != requester is re-checked. Shared-key access is disabled; only the server identity gets a data role; optional private endpoint. | A principal with blob write access can forge a consistent plan + record and thereby act with the server identity's rights. Treat data-plane access to this account as equivalent to Contributor on the environments. |
| T4 | Tampering | Compromised provider or Terraform binary | Exact versions pinned; SHA-256 verified at image build; providers served only from the image (`terraformrc` blocks the registry at run time). | Trust in HashiCorp's published checksums and the base image; no image signing or SBOM yet. |
| T5 | Tampering | Changes made outside Terraform (portal) | `detect_drift`, scheduled drift scan, alert rule. | Detection, not prevention. Add resource locks / Azure Policy for prevention. |
| R1 | Repudiation | "I never asked for that" | Every tool call is logged with Entra object id, UPN, tool, argument hash, outcome; plan/apply/approval events link planner, approver and applier; deployment history keeps the same. Two sinks: Log Analytics and blob. | Neither sink is immutable by default (add an immutability policy on the `audit` container; restrict Log Analytics delete rights). Argument *values* are deliberately not logged, only their hash plus safe fields. |
| I1 | Information disclosure | Secrets leak to the agent/chat | Templates use Entra-only auth (no passwords generated); sensitive plan values are masked before the plan JSON is stored or returned; sensitive outputs are masked; internal errors return only a reference id. | Terraform error text is passed through (trimmed) and could contain a value. State blobs contain whatever the provider stores (for example storage keys): protect the `tfstate` container. |
| I2 | Information disclosure | A user sees deployments of other teams | None: all authenticated users see all deployments and plans of the server. | By design in v2 (single platform team model). Run one server per trust domain if that is not acceptable. |
| D1 | Denial of service | Flood of plans (each starts Terraform) | Per-replica concurrency limit, one operation per deployment, quick return with polling, Easy Auth in front. | No per-user rate limit or quota. |
| D2 | Denial of service | Replica dies mid-operation and leaves locks | Leases with expiry; any replica recovers; orphaned state-blob lease is broken; graceful SIGTERM handling. | An apply interrupted mid-way leaves partially created resources until someone re-plans. |
| D3 | Denial of service / cost | Runaway spend | Budget cap on the estimate, approved SKU lists, blast-radius limit, time-boxed deployments. | The estimate is best-effort and covers fixed charges only; usage-based costs are not capped. |
| E1 | Elevation of privilege | Server identity used to reach beyond its environments | Contributor on the environment resource groups only; cannot assign roles; `resource_provider_registrations = "none"`; resource group and subscription are injected, never user-supplied. | Contributor can read keys of resources in those groups (listKeys). Templates that accept external IDs (subnets, private endpoint targets) can attach to resources elsewhere **if** the identity was granted rights there. |
| E2 | Elevation of privilege | Self-approval or approval by automation | Approver must differ from planner and requester; must be a signed-in person (no app-only, system or anonymous identity); optional approver group; approval bound to the exact plan. | Two colluding users. Without `-ApproverGroupId`, any second user qualifies. |
| E3 | Elevation of privilege | TTL reaper as a destroy backdoor | Acts only on deployments created with `ttl_hours`; the bypass of `enable_destroy` works only for the reaper identity on plans it created itself; policy still applies; never in approval environments. | The reaper intentionally ignores `enable_destroy=false` for those deployments. |
| E4 | Elevation of privilege | Local token broker abused | Loopback only, requires the `Metadata: true` header, hands out the same tokens any process in the container can already get from the platform. | Code execution inside the container equals the identity (as with any managed identity). |

## Not covered
* Compromise of the Entra tenant, the Power Platform environment or a tenant administrator.
* Content safety of the agent's conversation; data residency of Copilot Studio.
* Vulnerabilities in Terraform, providers, Python dependencies beyond version pinning.
* Multi-tenant isolation between teams inside one server (see I2).

## Recommended hardening checklist
1. `-SecurityGroupId` and `-ApproverGroupId`; end-user authentication in Copilot Studio.
2. Keep prod `require_approval: true`, `enable_destroy: false`; start every environment plan-only.
3. `-PrivateNetworking`; restrict who has any data role on the state storage account; add an immutability
   policy on the `audit` container.
4. `-EnableMonitoring`; review the workbook weekly; run query 4 in `audit-queries.kql` (two-person check).
5. Review `server/policies/default.json` against your own standards before enabling apply.
