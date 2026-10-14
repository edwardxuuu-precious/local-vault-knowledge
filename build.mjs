import {build} from "esbuild";
const common={bundle:true,platform:"node",target:"node24",format:"esm",sourcemap:false,legalComments:"inline",banner:{js:"#!/usr/bin/env node\nimport {createRequire} from \"node:module\"; const require=createRequire(import.meta.url);"}};
await build({...common,entryPoints:["src/interfaces/vault-standalone.ts"],outfile:"dist/cli.mjs"});
await build({...common,entryPoints:["src/interfaces/vault-mcp.ts"],outfile:"dist/mcp.mjs"});
