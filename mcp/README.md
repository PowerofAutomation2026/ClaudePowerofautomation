# Copilot Studio agent MCP server (VS Code)

Use a Copilot Studio agent — GitHub Copilot harness or Standard harness — from GitHub Copilot agent mode in VS Code.

**Setup**
1. Entra app registration: public client, delegated Power Platform API permission `CopilotStudio.Copilots.Invoke` (the `.Test` permission is not enough for the GitHub Copilot harness route).
2. The agent must be published, set to *Authenticate with Microsoft*, and shared with you.
3. Open the repo in VS Code, start `copilot-studio-agent` from `.vscode/mcp.json`, answer the prompts (tenant, client, environment ID, agent schema, harness).
4. Copilot Chat → Agent mode → enable the tools. First call shows a device-code sign-in.

**Features:** GitHub Copilot + Standard harness (auto-detected), several agents (`alias=schema,...`), streaming progress, optional reasoning / tool-call display (`SHOW_REASONING`, `SHOW_TOOLCALLS`), adaptive card + suggested reply rendering, `copilot_studio_diagnose` tool, `/ask_<alias>` prompts, optional refresh-token cache (`TOKEN_CACHE=file`, stored in `~/.copilot-studio-mcp`, mode 0600).

**Test:** `node test/lab.mjs` (mock Entra + mock Copilot Studio; no tenant needed).

**Unverified against a live tenant:** request/response payload shapes and the `thought` / `toolCall` entity field names. Run `copilot_studio_diagnose` first; paste any error back.
