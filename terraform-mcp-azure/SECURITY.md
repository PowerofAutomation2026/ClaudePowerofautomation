# Security

## Status
This package was built and tested **without access to an Azure tenant**. The security controls are
unit-tested (see README), but the deployment has not been penetration-tested or run in production.
Deploy to a sandbox subscription first and review [THREAT-MODEL.md](THREAT-MODEL.md).

## Security model in one page
* **Authentication**: Entra ID. Container Apps Easy Auth rejects anonymous calls with 401; the server then
  validates the access token itself (`AUTH_MODE=jwt`: RS256 signature against the tenant's keys, audience,
  issuer, tenant id, expiry). Identity = the `oid` of the validated token.
* **Authorization**: any authenticated caller may plan (within guardrails). Apply and destroy are switched on
  per environment. Approval environments require a second, different, signed-in person. Optional: restrict
  callers to a group (`-SecurityGroupId`) and approvers to a group (`-ApproverGroupId`).
* **Least privilege**: one user-assigned managed identity with `Contributor` on the environment resource
  groups, `Storage Blob Data Contributor` on the state account, `AcrPull` on the registry. Nothing at
  subscription scope; it cannot grant roles.
* **Input**: curated templates only; typed schema validation; user values never become HCL.
* **Policy gate**: every plan, again at apply. Rules are a JSON file in the image.
* **Secrets**: none stored by the server. Templates use Entra-only authentication and SSH public keys.
  The only secret created by the deploy script is the Copilot Studio connector client secret, written to
  `out/connector-client-secret.txt` (git-ignored) and nowhere else. Terraform state can contain
  provider-returned secrets: the state account has shared keys disabled, TLS 1.2, versioning and soft delete.
* **Supply chain**: Python dependencies, Terraform and providers are exact-pinned; Terraform and provider
  archives are checksum-verified at image build; no downloads at run time. Runs as a non-root user.
* **Audit**: per-call structured records with user identity to Log Analytics and blob storage.

## Things you must do yourself
* Use end-user authentication for the Copilot Studio connection (never a shared maker connection).
* Decide who may approve (`-ApproverGroupId`) and who may use the agent (`-SecurityGroupId`).
* Protect the state storage account: no extra data-plane role assignments; consider `-PrivateNetworking`
  and an immutability policy on the `audit` container.
* Rotate the connector client secret yearly: `-RotateConnectorSecret`.
* Rebuild the image regularly to pick up base-image patches; review pins when you do.
* Review and adapt `server/policies/default.json` and the template catalog to your standards.

## Known gaps
* No per-user rate limiting or quotas.
* In environments without approval, user confirmation before apply is enforced by agent instructions only.
* All users of one server can see all of its deployments and plans.
* Audit sinks are not immutable by default.
* No image signing, SBOM or vulnerability scan is included.
* Terraform error messages are returned (trimmed) and are not scrubbed for sensitive values.

## Reporting a vulnerability
Open a private security advisory on the repository that hosts this package (or contact its maintainers
privately). Please do not file public issues for vulnerabilities. Include the version (`server/tfmcp/__init__.py`),
a description, and steps to reproduce.
