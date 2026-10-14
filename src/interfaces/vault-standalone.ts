import { main } from "./vault-cli.js";
main().catch(error => { process.stderr.write(JSON.stringify({ error: String(error) }) + "\n"); process.exitCode = 2; });
