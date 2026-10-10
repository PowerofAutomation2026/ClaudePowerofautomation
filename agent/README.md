# Copilot Studio agent for the security findings (no Azure app registration)

How it works: the code app scans in the browser, then **📤 Publish to Copilot agent** saves the findings to the Dataverse table `occ_finding`
of the app's own environment (rows are keyed by a fingerprint: re-publishing updates, findings that disappeared are marked `fixed`, nothing is duplicated).
A Copilot Studio agent in the **same environment** reads that table with the **Dataverse MCP server** (exact questions) and/or **Dataverse knowledge** (fuzzy questions),
using the *asking user's* identity and Dataverse security roles. No service principal, no secret, no backend.
Code apps cannot be called as an API by an agent (they run in the browser), which is why the data is handed over through Dataverse.

## One-time setup (admin)
1. **Create the table** – run `scripts/Setup-OccDataverse.ps1` (asks for the Environment URL, signs you in, creates `occ_finding`). *Not tested live.* Manual alternative: make.powerapps.com → Tables → New table, name `occ_finding`, **user-owned**, primary column `occ_name` (Text 200), then add Text columns
   `occ_fingerprint, occ_module, occ_rule, occ_severity, occ_kind, occ_resourcename, occ_envname, occ_envid, occ_principal, occ_host, occ_snapshot, occ_status` (200; module/severity/status shorter is fine), Multiline text `occ_detail, occ_fixpayload` (≥ 9000), Date and time `occ_firstseen, occ_lastseen`.
2. **Re-run `Deploy.cmd`** – it adds the table to the app (`pac code add-data-source -a dataverse -t occ_finding`). Open any module → scan → **📤 Publish to Copilot agent**.
3. **Security roles** – rows are owned by the admin who published. Create a role *OCC Security Reader* (Settings → Users → Security roles → New; table `occ_finding`, **Read** at Business Unit level) and assign it to the admins who should ask the agent. Anyone else gets **zero rows**.
4. **Environment** – turn on Dataverse search; allow the Dataverse MCP server for the Copilot Studio client (Power Platform admin center → the environment → Settings; label may differ).
5. **Create the agent** (same environment) – Settings → Security → **Authenticate with Microsoft**. Paste `agent/instructions.md` as the instructions.
   Tools → Add tool → **MCP → Dataverse MCP Server** (uses your Dataverse connection; keep **end-user credentials**; disable the create/update/delete tools, keep `read_query`, `search_data`, `describe`).
   Knowledge → Dataverse → table `occ_finding` (optional, for fuzzy questions; add synonyms such as *webhook → host*).
6. **Share only with your admin group** and publish to Teams / Microsoft 365 Copilot. Test with a non-admin user: it must return nothing.
7. Try `agent/sample-questions.md`.

## Safety (this agent is itself checked by 🤖 Agent Guard)
* Read-only. The agent has no write tools; fixes happen in the app with dry-run, typed confirmation and read-back. (`occ_fixpayload` is stored so a future confirmed agent flow could apply the same fix – not shipped.)
* Do **not** use maker credentials, do **not** switch authentication off, do **not** share the agent tenant-wide: the table contains your security findings.
* Findings contain names and hosts, never secret values (secrets are reported as "a literal header was found").
* Publishing runs as the signed-in admin and counts against that user's Dataverse API limits (about 8 parallel writes with back-off; a few hundred findings per scan is typical).

## Unverified (treat the first run as a pilot)
Dataverse MCP server is still a preview feature and tool names change; the setup script and the SDK writes (`createRecordAsync` / `updateRecordAsync` on a custom table) have not been run against a live tenant; Dataverse knowledge is search-based – use the MCP `read_query` tool for exact lists and counts. The `pac code` CLI is being superseded by `pa` – if `add-data-source` changes, add the table with the new command.
