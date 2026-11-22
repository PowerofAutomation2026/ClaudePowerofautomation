# Security

**Status:** built and tested without an Azure tenant. Controls are unit-tested and exercised over HTTP with
locally signed tokens; none has been confirmed against live Entra ID / Azure. Read [THREAT-MODEL.md](THREAT-MODEL.md).

## Controls and where they are enforced
| Control | Enforced by |
|---|---|
| No apply/destroy without a human decision outside the agent | approval service (`tfmcp/approvals.py`, `approval_app.py`) + executor (`service._op_apply`) |
| Front-end cannot change Azure or approve | Azure RBAC: custom read-only role; `control` container read-only for its identity |
| Apply identity cannot grant roles, remove locks, change policy, delete resource groups (or prod data resources) | custom role definitions (`out/role-*.json`, defined in the deploy script) |
| Production resource groups and the MCP's own resource group cannot be deleted | CanNotDelete locks |
| Tagged `protected=true` resources cannot be deleted | Azure Policy `denyAction` (`-EnableDenyDeletePolicy`) |
| Protected deployments are never destroyed via MCP | flag in the trusted control store, checked at plan, approval, execution |
| Kill switch / quotas / change windows / rate limits / anomaly freeze | `tfmcp/guard.py` |
| Roles and per-user visibility | `service.roles_of`, `_need`, `_sees`, `_owns` |
| Untrusted output and log scrubbing | `tfmcp/sanitize.py` |
| Template/policy integrity | `tfmcp/integrity.py`, `integrity.json` |

## What you must configure
1. **Roles.** Assign Entra groups: `-RequesterGroupId`, `-ViewerGroupId`, `-AdminGroupId` (API app roles) and
   `-ApproverGroupId`, `-AdminGroupId` (approval app roles). Without a role every call is refused.
2. **Conditional Access for the approval app** (`<prefix>-approval`), in Entra ID > Conditional Access:
   require MFA, sign-in frequency *every time*, and ideally a compliant device or trusted location. The server
   additionally requires a sign-in younger than 10 minutes (`APPROVAL_MAX_AUTH_AGE_SECONDS`) and can require a
   claim: `-ApprovalRequireAmr mfa` works if the token carries an `amr` claim (v1.0 access tokens); with v2.0
   tokens use an authentication context (`acrs` claim, e.g. `c1`) enforced by Conditional Access.
3. **Conditional Access for the MCP API app** (optional): restrict to compliant devices / named locations.
4. **End-user authentication** in the Copilot Studio connection. A shared connection makes everyone one user.
5. **Lock the audit immutability policy** once you are satisfied (the script creates it unlocked, so it can
   still be removed): `az storage container immutability-policy lock`.
6. **Network egress** (if you add a firewall/NAT): allow `login.microsoftonline.com`, `management.azure.com`,
   `graph.microsoft.com`, `*.blob.core.windows.net` (state account), `prices.azure.com`, your registry, and the
   data-plane hosts of the services you deploy. Terraform never needs `registry.terraform.io` at run time.
7. **Registry.** For stronger provenance enable ACR quarantine / content trust (Premium) and Defender for
   containers; this package does not configure them.
8. **Secrets.** The server stores none. The connector client secret lives only in `out/` (git-ignored):
   rotate with `-RotateConnectorSecret`. The optional notification webhook URL is stored as a Container Apps
   secret. Nothing sensitive is placed in plain environment variables.
9. **Base image.** Pinned by digest in `server/Dockerfile`; refresh monthly (instructions in the file),
   rebuild, re-run the tests.

## Kill switch (break glass)
```
POST https://<approval-host>/api/freeze   {"frozen": true, "reason": "incident 1234"}   (admin role, approval-audience token)
```
While frozen: no plans, approval requests, approvals or applies; reads still work. Lifting it is the same call
with `false`. If the approval service itself is unavailable, an Owner can write `freeze.json`
(`{"frozen": true, "reason": "..."}`) into the `control` container, or simply stop both container apps.

## Not implemented / limits
* Read-only root filesystem and dropped Linux capabilities: not configurable for Azure Container Apps as far
  as we know; the container runs as a non-root user and writes only to its temp directory.
* Image signing, SBOM, vulnerability scanning; subresource integrity for the MSAL script on the approval page.
* Rate limits are per user and global, not per source IP.
* State is readable by the front-end identity (needed for planning).
* `JWKS_FILE` is a local-testing hook that replaces Entra's signing keys - never set it in a deployment.

## Reporting a vulnerability
Open a private security advisory on the repository that hosts this package, or contact its maintainers
privately. Include the version (`server/tfmcp/__init__.py`), a description and steps to reproduce.
