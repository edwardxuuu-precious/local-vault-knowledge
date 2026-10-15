import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { initializeLocalVault } from "../src/application/local-vault-pack.js";
import { fileHash, walk } from "../src/application/local-vault-files.js";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const wrapper = fileURLToPath(new URL("../src/interfaces/local-knowledge-hook-command.mjs", import.meta.url));
async function fixture(fake?: string) {
  const dir = await mkdtemp(join(tmpdir(), "local-knowledge-command-test-")); owned.push(dir);
  const reader = join(dir, "reader"), vault = join(dir, "vault"), workspace = join(dir, "project");
  await initializeLocalVault(vault); await mkdir(join(reader, "dist"), { recursive: true }); await mkdir(workspace);
  if (fake) await writeFile(join(reader, "dist/cli.mjs"), fake); else await copyFile(join(process.cwd(), "dist/cli.mjs"), join(reader, "dist/cli.mjs"));
  await writeFile(join(reader, ".context-router-storage.json"), JSON.stringify({ root: join(vault, "90_系统") }));
  await mkdir(join(vault, "30_知识与经验"));
  await writeFile(join(vault, "30_知识与经验/样本.md"), '---\nlocal_id: command-sample\nprojects: ["*"]\ntype: research\n---\n# 隔离方法样本\n\n## 结论与用法\n排查设备导入前检查状态。\n\n## 适用边界\n只用于隔离验收，实际效果未知。\n');
  const config = join(dir, "connection.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, readerRoot: reader, hook: { enabled: true, timeoutMs: 1000 } }));
  return { dir, reader, vault, workspace, config };
}
async function inventory(root: string) { return Promise.all((await walk(root)).map(async p => [p, await fileHash(join(root, p))])); }
async function invoke(config: string, input: string, kill = false, event?: string) {
  const child = spawn(process.execPath, [wrapper, "--config", config, ...(event ? ["--event", event] : [])], { stdio: ["pipe", "pipe", "pipe"], detached: kill && process.platform !== "win32" });
  let stdout = "", stderr = ""; child.stdout.on("data", d => { stdout += String(d); }); child.stderr.on("data", d => { stderr += String(d); });
  child.stdin.on("error", () => {}); child.stdin.end(input);
  const timer = kill ? setTimeout(() => {
    try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
  }, 60) : undefined;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.on("error", reject); child.on("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer); return { ...result, stdout, stderr };
}
const request = (cwd: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "owned-command-session", turn_id: "owned-command-turn", cwd, prompt: "排查设备导入失败，参考知识与经验" });
it("runs the actual packaged reader through the command wrapper without growing any fixture files", async () => {
  const f = await fixture(), before = await inventory(f.dir);
  for (let i = 0; i < 5; i++) {
    const result = await invoke(f.config, request(f.workspace)); expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout); expect(output.hookSpecificOutput?.additionalContext).toContain("command-sample");
    const text = output.hookSpecificOutput.additionalContext;
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1))).toMatchObject({ trigger: "UserPromptSubmit", retrievalScope: "task_query", taskQueryAvailable: true });
    expect(output.hookSpecificOutput?.additionalContext.length).toBeLessThanOrEqual(2400);
  }
  expect(await inventory(f.dir)).toEqual(before);
});
it("returns non-blocking bounded notice on timeout and never creates recovery or process files", async () => {
  const f = await fixture("setTimeout(()=>{},60000);"), before = await inventory(f.dir), started = Date.now();
  const result = await invoke(f.config, request(f.workspace)); expect(result.code).toBe(0);
  expect(Date.now() - started).toBeLessThan(4000); expect(result.stdout).toContain("未完成自动查询");
  expect(JSON.parse(result.stdout).decision).toBeUndefined(); expect(await inventory(f.dir)).toEqual(before);
});
it("drops malformed or blocking child output instead of granting a new lifecycle gate", async () => {
  const f = await fixture('process.stdout.write(JSON.stringify({decision:"block",reason:"forbidden-child-output"}));'), before = await inventory(f.dir);
  const result = await invoke(f.config, request(f.workspace)); expect(result.code).toBe(0);
  expect(result.stdout).toContain("未完成自动查询"); expect(result.stdout).not.toContain("forbidden-child-output");
  expect(await inventory(f.dir)).toEqual(before);
});
it("rejects malformed input, respects its own disable switch and remains independent of Router", async () => {
  const f = await fixture(), before = await inventory(f.dir);
  expect((await invoke(f.config, "{broken")).stdout).toContain("未完成自动查询");
  expect(await inventory(f.dir)).toEqual(before);
  const config = JSON.parse(await readFile(f.config, "utf8")); config.hook.enabled = false; await writeFile(f.config, JSON.stringify(config));
  const disabled = await invoke(f.config, request(f.workspace)); expect(JSON.parse(disabled.stdout)).toEqual({});
});
it("leaves no database copies or per-run files when an owned actual reader process group is killed", async () => {
  const f = await fixture(), before = await inventory(f.dir);
  const result = await invoke(f.config, request(f.workspace), true); expect(result.signal).toBe("SIGKILL");
  expect(await inventory(f.dir)).toEqual(before);
});
it("delivers startup context in its real event namespace and keeps timeout notices in that namespace", async () => {
  const text = "独立本地知识 Hook：isolated startup reference";
  const f = await fixture(`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:${JSON.stringify(text)}}}));`);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "startup-session", cwd: f.workspace });
  const before = await inventory(f.dir), result = await invoke(f.config, input, false, "SessionStart");
  expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  expect(await inventory(f.dir)).toEqual(before);
  await writeFile(join(f.reader, "dist/cli.mjs"), "setTimeout(()=>{},60000);");
  const timedOut = JSON.parse((await invoke(f.config, input, false, "SessionStart")).stdout);
  expect(timedOut.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(timedOut.hookSpecificOutput.additionalContext).toContain("未完成自动查询");
});
it("rejects an output event that differs from the configured startup event", async () => {
  const f = await fixture('process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"独立本地知识 Hook：wrong-event"}}));');
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "startup-session", cwd: f.workspace });
  const result = JSON.parse((await invoke(f.config, input, false, "SessionStart")).stdout);
  expect(result.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(result.hookSpecificOutput.additionalContext).not.toContain("wrong-event");
});
it("distinguishes packaged bootstrap, task hits and completed empty queries without changing its fixture", async () => {
  const f = await fixture();
  await writeFile(join(f.vault, "90_系统/config/projects.yaml"), JSON.stringify({ projects: [{ id: "startup-project", name: "Startup", root: f.workspace }] }));
  await mkdir(join(f.vault, "20_项目"));
  await writeFile(join(f.vault, "20_项目/facts.md"), '---\nlocal_id: startup-facts\ntype: project\nprojects: [startup-project]\n---\n# 项目当前事实\n\n## 当前状态\n本机入口已核验，长期效果未知。\n');
  const before = await inventory(f.dir);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "startup-session", cwd: f.workspace });
  const result = JSON.parse((await invoke(f.config, input, false, "SessionStart")).stdout);
  expect(result.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(result.hookSpecificOutput.additionalContext).toContain('"retrievalScope":"project_bootstrap"');
  expect(result.hookSpecificOutput.additionalContext).toContain('"id":"startup-facts"');
  expect(result.hookSpecificOutput.additionalContext).not.toContain("command-sample");
  const task = { ...JSON.parse(request(f.workspace)), session_id: "startup-session" };
  for (const prompt of [task.prompt, "研究 zyxnonexistent"]) {
    const reply = JSON.parse((await invoke(f.config, JSON.stringify({ ...task, prompt }))).stdout);
    const text = reply.hookSpecificOutput.additionalContext, payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
    expect(payload).toMatchObject({ trigger: "UserPromptSubmit", retrievalScope: "task_query", taskQueryAvailable: true, projectTruthLoaded: false });
    expect(payload.hits.map((h: { id: string }) => h.id)).toEqual(prompt === task.prompt ? ["command-sample"] : []);
    expect(text.length).toBeLessThanOrEqual(2400);
  }
  expect(await inventory(f.dir)).toEqual(before);
});
