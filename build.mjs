import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const memoryWasm = (await readFile(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"))).toString("base64");
const common = {
  bundle: true,
  define: { __LOCAL_KNOWLEDGE_WASM_BASE64__: JSON.stringify(memoryWasm) },
  platform: "node", target: "node24", format: "esm", sourcemap: false, legalComments: "inline",
  banner: { js: "#!/usr/bin/env node\nimport {createRequire as __vaultRequire} from 'node:module'; import {fileURLToPath as __vaultFilePath} from 'node:url'; import {dirname as __vaultDirname} from 'node:path'; const require=__vaultRequire(import.meta.url); const __filename=__vaultFilePath(import.meta.url); const __dirname=__vaultDirname(__filename);" },
};
await build({ ...common, entryPoints: ["src/interfaces/vault-standalone.ts"], outfile: "dist/cli.mjs" });
await build({ ...common, entryPoints: ["src/interfaces/vault-mcp.ts"], outfile: "dist/mcp.mjs" });
