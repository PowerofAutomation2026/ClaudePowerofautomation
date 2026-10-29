# Copilot Studio agents in VS Code — zero-touch package

Gives GitHub Copilot (Agent mode) in VS Code a tool for each of your Copilot Studio agents — GitHub Copilot harness or Standard harness.

## Install (one command)

| OS | Run |
|---|---|
| Windows | double-click **Install.cmd** (installs Node.js / Azure CLI with winget if missing) |
| macOS / Linux | `./install.sh` |

You need: **Node 18+**, **Azure CLI**, **VS Code 1.99+ with GitHub Copilot**, and an Azure account that can create app registrations in your tenant. Everything else is automatic:

1. signs in with `az login` (if not already)
2. creates (or reuses) an Entra app **"Copilot Studio MCP for VS Code"** — public client, with delegated Power Platform API permission `CopilotStudio.Copilots.Invoke`, and tries admin consent
3. finds your Power Platform environment (your default, or pick one) and your **published agents**
4. installs the MCP server to `~/.copilot-studio-mcp/`
5. adds a `copilot-studio-agent` entry to your **VS Code user `mcp.json`** (existing servers are kept; a `.bak` is written)
6. does the device-code sign-in once and checks every agent end to end

Unattended: `./install.sh --yes` (default environment, all published agents). Preview only: `--dry-run`.

## Connect in VS Code

1. **Reload VS Code** (`Ctrl/Cmd+Shift+P` → *Developer: Reload Window*).
2. Open **Copilot Chat** → switch mode to **Agent** → click the **tools** icon → make sure the `copilot-studio-agent` tools (`ask_<agent>`) are ticked.
3. Ask: *"Use ask_hr_helper to …"*. Each agent also appears as a `/` prompt. If something is wrong, ask for the **`copilot_studio_diagnose`** tool.

Check status or restart: `Ctrl/Cmd+Shift+P` → *MCP: List Servers*.

## Options (`./install.sh --help`)

`--env-id <guid>` · `--agent alias=schema` (repeatable) · `--all-agents` · `--harness auto|github|standard` · `--client-id <id>` (use an app someone already created) · `--workspace [dir]` (project-level `.vscode/mcp.json` instead of user config) · `--insiders` · `--show-reasoning` `--show-toolcalls` · `--no-verify`

## Requirements on the agent

Published · authentication **Authenticate with Microsoft** · shared with the user · for GitHub Copilot harness agents the harness must be enabled in your environment (preview, rolling out by region).

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 | Consent missing: ask an admin to grant consent to the app, or sign in again; `.Test` permission is not enough |
| 403 | Agent not published/shared, or *Authenticate with Microsoft* is off |
| 404 | Wrong environment / schema name (case-sensitive), unpublished, or GitHub harness route not yet enabled in your region |
| "Power Platform API … not available" | You need rights to add the Power Platform API service principal (Application Administrator or higher) |
| Re-do sign-in | delete `~/.copilot-studio-mcp/*.json` (token cache) and re-run the installer |

## Uninstall

`node provision.mjs --remove` (add `--delete-app` to delete the Entra app too).

## Security notes

No secrets are stored in `mcp.json`. The sign-in refresh token is cached in `~/.copilot-studio-mcp/` (file mode 0600). Agents run with **your** identity and permissions.
