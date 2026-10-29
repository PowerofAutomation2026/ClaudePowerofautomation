// Builds packages/copilot-studio-vscode/ and packages/copilot-studio-vscode.zip from provision/ + mcp/.
import { mkdirSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages"), pkg = join(out, "copilot-studio-vscode");
rmSync(pkg, { recursive: true, force: true }); rmSync(`${pkg}.zip`, { force: true });
mkdirSync(join(pkg, "server"), { recursive: true });
for (const f of ["provision.mjs", "Install.cmd", "install.sh", "README.md"]) copyFileSync(join(root, "provision", f), join(pkg, f));
copyFileSync(join(root, "mcp", "copilot-studio-mcp.mjs"), join(pkg, "server", "copilot-studio-mcp.mjs"));
chmodSync(join(pkg, "install.sh"), 0o755);
execFileSync("zip", ["-qr", `${pkg}.zip`, "copilot-studio-vscode"], { cwd: out });
console.log(`Built ${pkg}.zip`);
