/**
 * Cross-platform launcher for scripts/backup-db.sh.
 * On Windows, prefers Git Bash over the broken Store/WSL `bash.exe` stub.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "backup-db.sh");

const candidates =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        "bash",
      ]
    : ["bash"];

let bash = null;
for (const c of candidates) {
  if (c === "bash" || fs.existsSync(c)) {
    bash = c;
    break;
  }
}

if (!bash) {
  console.error("error: bash not found (install Git for Windows or use a Unix shell)");
  process.exit(1);
}

const result = spawnSync(bash, [script], {
  stdio: "inherit",
  env: process.env,
  cwd: path.join(__dirname, ".."),
});

process.exit(result.status ?? 1);
