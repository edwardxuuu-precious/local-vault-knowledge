import {readFile,realpath} from "node:fs/promises";
import {homedir} from "node:os"; import {isAbsolute,join} from "node:path"; import {pathToFileURL} from "node:url";
try {
  const configHome=process.env.CODEX_HOME||join(homedir(),".codex");
  const args=process.argv.slice(2);
  if(args.length&&(args.length!==2||args[0]!=="--config"||!isAbsolute(args[1])))throw Error("Invalid config argument");
  const config=JSON.parse(await readFile(args[1]??join(configHome,"local-knowledge.json"),"utf8"));
  if(!config.hook?.enabled)process.stdout.write("{}\n");
  else {
    if(config.schemaVersion!==1||typeof config.readerRoot!=="string"||!isAbsolute(config.readerRoot))throw Error("Invalid reader configuration");
    const root=await realpath(config.readerRoot);
    await import(pathToFileURL(join(root,"src/interfaces/local-knowledge-hook-command.mjs")).href);
  }
} catch {
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"独立本地知识 Hook 未完成自动查询。按 local-knowledge Skill 只读查询必要资料，旧 Context Router 保持关闭，保存仍须用户确认。"}})+"\n");
}
