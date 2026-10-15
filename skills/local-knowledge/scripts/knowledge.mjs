import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const allowed = new Set(["search", "get", "context", "change-preview", "capture-preview", "capture-save", "refresh"]);
if (!allowed.has(command)) throw new Error("Use search, get, context, change-preview, capture-preview, capture-save or refresh");
const configHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const config = JSON.parse(await readFile(join(configHome, "local-knowledge.json"), "utf8"));
if (config.schemaVersion !== 1 || typeof config.readerRoot !== "string" || !isAbsolute(config.readerRoot))
  throw new Error("Explicit local knowledge reader configuration is required");
const root = await realpath(config.readerRoot);
const cli = await realpath(join(root, "dist/cli.mjs"));
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, "--root", root, "vault", command, ...args], { stdio: "inherit", timeout: 60000 });
  child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal }));
});
if (result.signal) throw new Error("Local knowledge command stopped: " + result.signal);
process.exitCode = result.code ?? 1;
