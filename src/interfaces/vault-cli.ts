import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { LocalVault } from "../application/local-vault.js";
import { exportPrivatePackage, exportPublicPackage, importPackage, inspectPackage, previewPublicPackage, initializeLocalVault, bindImportedCopy,
  previewReturnedEdits, type PublicDraft } from "../application/local-vault-pack.js";
import { refreshLocalNavigation } from "../application/local-vault-navigation.js";
import { applyOrganization, previewOrganization, type OrganizationPreview } from "../application/local-vault-organization.js";
import { previewCaptureFiles, applyCapture, type CaptureDraft, type CapturePreview } from "../application/local-vault-capture.js";
import { runLocalKnowledgeHook, knowledgeHookUnavailable } from "../application/local-knowledge-hook.js";

export function registerVaultCommands(program: Command) {
  const vault = program.command("vault").description("Local-first knowledge tools; no Router hooks, lifecycle or background writes");
  const root = () => {
    const value = program.opts<{ root?: string }>().root;
    if (!value) throw new Error("Explicit --root is required; no cwd fallback"); return value;
  };
  const open = () => LocalVault.open(root());
  const render = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); };
  vault.command("knowledge-hook").option("--max-hits <number>", "One to three references", "2")
    .option("--max-context-chars <number>", "1000 to 4000 characters", "2400")
    .action(async options => {
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        input += String(chunk); if (Buffer.byteLength(input) > 131072) { render(knowledgeHookUnavailable()); return; }
      }
      try { render(await runLocalKnowledgeHook(JSON.parse(input), root(), { maxHits: Number(options.maxHits), maxContextChars: Number(options.maxContextChars) })); }
      catch { render(knowledgeHookUnavailable()); }
    });
  vault.command("init").requiredOption("--destination <new-directory>").requiredOption("--confirm-new-vault")
    .action(async options => {
      render(await initializeLocalVault(options.destination));
      render(await refreshLocalNavigation(await LocalVault.open(options.destination)));
    });
  vault.command("search").argument("<query>").option("--project <id>").option("--limit <number>", "Maximum 20", "5")
    .action(async (q, options) => render((await open()).search(q, options.project, Number(options.limit))));
  vault.command("get").argument("<id>").action(async id => render((await open()).get(id)));
  vault.command("context").argument("<task>").option("--workspace <path>").option("--project <id>")
    .action(async (q, options) => render(await (await open()).buildContext(q, options.workspace, options.project)));
  vault.command("change-preview").argument("<id>").requiredOption("--base-hash <hash>").requiredOption("--file <path>")
    .action(async (id, options) => render((await open()).previewChange(id, options.baseHash, await readFile(options.file, "utf8"))));
  vault.command("capture-preview").requiredOption("--file <draft-json>", "One to five proposed knowledge changes")
    .action(async options => render(await previewCaptureFiles(await open(), JSON.parse(await readFile(options.file, "utf8")) as CaptureDraft[])));
  vault.command("capture-save").requiredOption("--preview <reviewed-json>").requiredOption("--expected-preview-hash <hash>")
    .requiredOption("--confirm", "Use only after the user confirms these exact changes")
    .action(async options => render(await applyCapture(await open(), JSON.parse(await readFile(options.preview, "utf8")) as CapturePreview,
      options.expectedPreviewHash, Boolean(options.confirm))));
  vault.command("refresh").description("Refresh navigation and default reading scope; existing current bodies are preserved")
    .action(async () => render(await refreshLocalNavigation(await open())));
  vault.command("organize-preview").action(async () => render(await previewOrganization(await open())));
  vault.command("organize-apply").requiredOption("--file <preview-json>").requiredOption("--expected-preview-hash <hash>")
    .action(async options => render(await applyOrganization(await open(),
      JSON.parse(await readFile(options.file, "utf8")) as OrganizationPreview, options.expectedPreviewHash)));
  vault.command("export").requiredOption("--kind <kind>", "full or mobile").requiredOption("--destination <path>")
    .option("--ids <json>", "Explicit selected note IDs")
    .action(async options => {
      if (!["full", "mobile"].includes(options.kind)) throw new Error("Expected full or mobile package");
      render(await exportPrivatePackage(await open(), options.kind, options.destination, options.ids ? JSON.parse(options.ids) : undefined));
    });
  vault.command("inspect").argument("<package>").option("--full-manifest", "Explicit machine-readable file-level validation input")
    .action(async (path, options) => {
      const m = await inspectPackage(path);
      render(options.fullManifest ? m : { format: m.format, version: m.version, kind: m.kind, packageId: m.packageId,
        files: m.files.length, bytes: m.files.reduce((n, f) => n + f.bytes, 0), notes: m.notes.length,
        sqlite: m.sqlite ? { events: m.sqlite.events, eventHash: m.sqlite.eventHash } : null, verified: true });
    });
  vault.command("import").argument("<package>").requiredOption("--destination <new-directory>").requiredOption("--expected-id <id>")
    .option("--human-confirm", "Human CLI confirms full-package staging; does not activate a store")
    .action(async (path, options) => render(await importPackage(path, options.destination, options.expectedId, Boolean(options.humanConfirm))));
  vault.command("returned-edits").argument("<working-copy>").action(async path => render(await previewReturnedEdits(await open(), path)));
  vault.command("bind-import").argument("<package>").requiredOption("--destination <directory>").requiredOption("--expected-id <id>")
    .requiredOption("--reviewer <name>").requiredOption("--confirm-source-frozen")
    .requiredOption("--backup-path <directory>").requiredOption("--code-root <directory>")
    .description("Human-only active-store binding; leaves Hook/MCP settings untouched")
    .action(async (path, options) => render(await bindImportedCopy(path, options.destination, {
      expectedId: options.expectedId, actor: "human_cli", reviewer: options.reviewer,
      confirmSourceFrozen: Boolean(options.confirmSourceFrozen), backupPath: options.backupPath, codeRoot: options.codeRoot,
    })));
  vault.command("public-preview").requiredOption("--file <draft-json>")
    .action(async options => render(previewPublicPackage(await open(), JSON.parse(await readFile(options.file, "utf8")) as PublicDraft[])));
  vault.command("public-export").requiredOption("--file <draft-json>").requiredOption("--expected-preview-hash <hash>")
    .requiredOption("--reviewer <name>").requiredOption("--confirm").requiredOption("--destination <path>")
    .action(async options => render(await exportPublicPackage(await open(), JSON.parse(await readFile(options.file, "utf8")) as PublicDraft[],
      options.expectedPreviewHash, options.reviewer, Boolean(options.confirm), options.destination)));
  return vault;
}
export async function main(argv = process.argv) {
  const program = new Command().name("vault-knowledge").option("--root <path>", "Configured code root or Vault").option("--json");
  registerVaultCommands(program);
  await program.parseAsync(argv);
}
