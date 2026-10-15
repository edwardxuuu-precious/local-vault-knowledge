import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initialize from "sql.js";

declare const __LOCAL_KNOWLEDGE_WASM_BASE64__: string;

const maxInputBytes = 256 * 1024 * 1024;
type Stamp = { identity: string; size: number } | null;
async function stamp(path: string): Promise<Stamp> {
  try {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw new Error("Unsafe canonical database input");
    if (s.size > BigInt(maxInputBytes)) throw new Error("Canonical database exceeds the memory read budget");
    return { identity: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":"), size: Number(s.size) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function bytes(path: string, expected: Stamp): Promise<Buffer> {
  if (!expected) return Buffer.alloc(0);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const result = await file.readFile(); if (result.length !== expected.size) throw new Error("Canonical input changed during read"); return result; }
  finally { await file.close(); }
}
function checksum(data: Buffer, little: boolean, a = 0, b = 0): [number, number] {
  for (let i = 0; i < data.length; i += 8) {
    a = (a + (little ? data.readUInt32LE(i) : data.readUInt32BE(i)) + b) >>> 0;
    b = (b + (little ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)) + a) >>> 0;
  }
  return [a, b];
}
/** SQLite's committed WAL page view, in RAM only. No recovery or source writes.
 * https://www.sqlite.org/fileformat.html#walformat
 */
export function committedMemoryImage(main: Buffer, wal: Buffer): Buffer {
  if (main.length < 100 || main.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("Invalid canonical SQLite header");
  if (![1, 2].includes(main[18]!) || ![1, 2].includes(main[19]!)) throw new Error("Unsupported canonical SQLite file format");
  const pageSize = main.readUInt16BE(16) === 1 ? 65536 : main.readUInt16BE(16);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || main.length % pageSize)
    throw new Error("Invalid canonical SQLite page size");
  let pages = main.length / pageSize, commitEnd = 32;
  if (wal.length) {
    if (wal.length < 32 || ![0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0))
      || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== pageSize) throw new Error("Invalid canonical WAL header");
    const little = wal.readUInt32BE(0) === 0x377f0682;
    let [a, b] = checksum(wal.subarray(0, 24), little);
    if (a !== wal.readUInt32BE(24) || b !== wal.readUInt32BE(28)) throw new Error("Canonical WAL header checksum mismatch");
    for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
      // WAL reset can leave frames from the previous salt generation at the tail.
      if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) break;
      [a, b] = checksum(wal.subarray(offset, offset + 8), little, a, b);
      [a, b] = checksum(wal.subarray(offset + 24, offset + 24 + pageSize), little, a, b);
      if (a !== wal.readUInt32BE(offset + 16) || b !== wal.readUInt32BE(offset + 20)) throw new Error("Canonical WAL frame checksum mismatch");
      if (!wal.readUInt32BE(offset)) throw new Error("Invalid canonical WAL page number");
      const committedPages = wal.readUInt32BE(offset + 4);
      if (committedPages) { pages = committedPages; commitEnd = offset + 24 + pageSize; }
    }
  }
  if (!pages || pages * pageSize > maxInputBytes) throw new Error("Committed database exceeds the memory read budget");
  const image = Buffer.alloc(pages * pageSize); main.copy(image, 0, 0, Math.min(main.length, image.length));
  for (let offset = 32; wal.length && offset < commitEnd; offset += 24 + pageSize) {
    const page = wal.readUInt32BE(offset);
    if (page <= pages) wal.copy(image, (page - 1) * pageSize, offset + 24, offset + 24 + pageSize);
  }
  // This consolidated private image has no WAL. Change only its in-memory header.
  image[18] = 1; image[19] = 1; image.writeUInt32BE(pages, 28); image.writeUInt32BE(image.readUInt32BE(24), 92);
  return image;
}
let engine: ReturnType<typeof initialize> | undefined;
async function memoryEngine() {
  if (!engine) {
    const wasmBinary = typeof __LOCAL_KNOWLEDGE_WASM_BASE64__ === "string"
      ? Buffer.from(__LOCAL_KNOWLEDGE_WASM_BASE64__, "base64")
      : await readFile(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
    engine = initialize({ wasmBinary });
  }
  return engine;
}
/** Native source files are never opened by SQLite; its VFS exists only in RAM. */
export async function readMemoryDocuments(path: string): Promise<Array<Record<string, unknown>>> {
  const paths = [path, path + "-wal", path + "-journal"], before = await Promise.all(paths.map(stamp));
  if (!before[0] || before.reduce((n, s) => n + (s?.size ?? 0), 0) > maxInputBytes) throw new Error("Canonical database is unavailable or too large");
  if (before[2]?.size) throw new Error("Rollback journal needs a separate verified read; automatic lookup skipped");
  const assertUnchanged = async () => {
    const after = await Promise.all(paths.map(stamp));
    if (after.some((s, i) => s?.identity !== before[i]?.identity)) throw new Error("Canonical database changed during memory read");
  };
  const [main, wal] = await Promise.all([bytes(path, before[0]!), bytes(path + "-wal", before[1]!)]);
  await assertUnchanged();
  const SQL = await memoryEngine(), db = new SQL.Database(committedMemoryImage(main!, wal!));
  try {
    const result = db.exec("PRAGMA query_only=ON; SELECT id, project_id, status, privacy_class, source_ref, updated_at FROM documents LIMIT 20001")[0];
    if (result && result.values.length > 20000) throw new Error("Canonical document count exceeds the hook read budget");
    const rows = result?.values.map(row => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))) ?? [];
    await assertUnchanged(); return rows;
  } finally { db.close(); }
}
