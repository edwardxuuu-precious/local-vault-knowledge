import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";

// Only read/configure the independent local reader. No Router services or lifecycle.
let event = "UserPromptSubmit";
const fallback = () => ({ hookSpecificOutput: { hookEventName: event, additionalContext:
  "独立本地知识 Hook 未完成自动查询。不要声称已查到经验；需要时按 local-knowledge Skill 只读查询，继续其他已授权工作。旧 Context Router 保持关闭，保存仍须用户确认。" } });
let child, finished = false, timer;
const finish = value => { if (finished) return; finished = true; clearTimeout(timer); child?.kill("SIGKILL"); process.stdout.write(JSON.stringify(value) + "\n"); };
process.on("SIGTERM", () => finish(fallback())); process.on("SIGINT", () => finish(fallback()));
process.stdout.on("error", () => { child?.kill("SIGKILL"); process.exit(0); });
try {
  const configHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const args = process.argv.slice(2);
  let configPath = join(configHome, "local-knowledge.json");
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (seen.has(key)) throw new Error("Duplicate Hook option"); seen.add(key);
    if (key === "--event" && ["UserPromptSubmit", "SessionStart"].includes(value)) event = value;
    else if (key === "--config" && typeof value === "string" && isAbsolute(value)) configPath = value;
    else throw new Error("Explicit configuration file and supported event required");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.hook?.enabled) finish({});
  else {
    const maxHits = config.hook.maxHits ?? 2, maxChars = config.hook.maxContextChars ?? 2400, timeoutMs = config.hook.timeoutMs ?? 4000;
    if (config.schemaVersion !== 1 || typeof config.readerRoot !== "string" || !isAbsolute(config.readerRoot)
      || !Number.isInteger(maxHits) || maxHits < 1 || maxHits > 3 || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 4000
      || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 4000) throw new Error("Invalid independent reader configuration");
    timer = setTimeout(() => { process.stdin.destroy(); finish(fallback()); }, timeoutMs);
    const root = await realpath(config.readerRoot), cli = await realpath(join(root, "dist/cli.mjs"));
    if (relative(root, cli).startsWith("..") || isAbsolute(relative(root, cli))) throw new Error("Reader entry escapes configured root");
    let input = ""; process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 131072) throw new Error("Bounded Hook input required"); }
    if (!finished) {
      if (JSON.parse(input).hook_event_name !== event) throw new Error("Hook input event differs from configured event");
      child = spawn(process.execPath, [cli, "--root", root, "vault", "knowledge-hook", "--max-hits", String(maxHits), "--max-context-chars", String(maxChars)], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", data => { output += data; if (Buffer.byteLength(output) > 20000) finish(fallback()); });
      child.stderr.resume(); child.on("error", () => finish(fallback()));
      child.on("close", code => {
        if (finished) return;
        try {
          if (code !== 0) throw new Error("Reader command failed");
          const value = JSON.parse(output);
          if (Object.keys(value).length === 0) finish({});
          else {
            const context = value.hookSpecificOutput?.additionalContext;
            if (Object.keys(value).length !== 1 || value.hookSpecificOutput?.hookEventName !== event
              || typeof context !== "string" || context.length > maxChars || !context.startsWith("独立本地知识 Hook")) throw new Error("Invalid advisory output");
            finish({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
          }
        } catch { finish(fallback()); }
      });
      child.stdin.on("error", () => finish(fallback())); child.stdin.end(input);
    }
  }
} catch { finish(fallback()); }
