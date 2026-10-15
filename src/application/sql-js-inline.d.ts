declare module "sql.js" {
  interface MemoryDatabase {
    exec(sql: string): Array<{ columns: string[]; values: Array<Array<string | number | null | Uint8Array>> }>;
    close(): void;
  }
  export default function initialize(options: { wasmBinary: Uint8Array }): Promise<{ Database: new (data: Uint8Array) => MemoryDatabase }>;
}
