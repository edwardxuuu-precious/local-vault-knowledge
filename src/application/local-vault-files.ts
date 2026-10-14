import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function stable(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function inside(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === ".." || part === ".") || !path)
    throw new Error("Unsafe relative path: " + path);
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes root");
  return target;
}
export async function regular(root: string, path: string): Promise<string> {
  const target = inside(root, path);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symlink is not allowed: " + path);
  }
  if (!(await lstat(target)).isFile()) throw new Error("Expected regular file: " + path);
  if (relative(await realpath(root), await realpath(target)).startsWith("..")) throw new Error("Path escapes real root");
  return target;
}
export async function walk(root: string, exclude: (path: string) => boolean = () => false): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), rel = relative(root, path).split("\\").join("/");
      if (exclude(rel)) continue;
      if (entry.isSymbolicLink()) throw new Error("Symlink is not allowed: " + rel);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(rel);
      else throw new Error("Special file is not allowed: " + rel);
      if (result.length > 100_000) throw new Error("File inventory exceeds bounded limit");
    }
  }
  await visit(root); return result;
}
export async function fileHash(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536), before = await handle.stat({ bigint: true });
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(offset) !== after.size)
      throw new Error("File changed during read: " + path);
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function stamp(path: string): Promise<string | null> {
  try {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw new Error("SQLite input must be a regular file");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** A witnessed detached DB+WAL prevents SQLite read side effects on the real Vault. */
export async function detachedSqlite<T>(path: string, callback: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
  const paths = [path, path + "-wal", path + "-journal"], stamps = await Promise.all(paths.map(stamp));
  if (!stamps[0]) throw new Error("Canonical SQLite is unavailable");
  const dir = await mkdtemp(join(tmpdir(), "llmw-vault-read-"));
  let db: DatabaseSync | undefined;
  async function unchanged() {
    if (stable(await Promise.all(paths.map(stamp))) !== stable(stamps)) throw new Error("SQLite changed during snapshot");
  }
  try {
    const copy = join(dir, "knowledge.sqlite");
    for (const [i, p] of paths.entries()) if (stamps[i]) {
      await copyFile(p, copy + p.slice(path.length));
      if (await fileHash(p) !== await fileHash(copy + p.slice(path.length))) throw new Error("SQLite snapshot mismatch");
    }
    await unchanged();
    db = new DatabaseSync(copy, { readOnly: true });
    const result = await callback(db);
    await unchanged(); return result;
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
}
export async function writeChanged(path: string, body: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (current === body) return false;
  await mkdir(dirname(path), { recursive: true });
  // In-place update retains birthtime of existing editable files.
  await writeFile(path, body, { mode: 0o600 }); return true;
}
