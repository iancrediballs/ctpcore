// Public build: stands in for @powersync/web. Only AppSchema.ts reaches it,
// and only for the table and column NAMES (db.ts creates the sql.js tables
// from them). No sync engine, no wasm workers in the public bundle.
type Cols = Record<string, string>;
export const column = { text: "text", integer: "integer", real: "real" } as const;
export class Table {
  cols: Cols;
  constructor(cols: Cols, _opts?: unknown) { this.cols = cols; }
}
export class Schema {
  tables: { name: string; columns: { name: string }[] }[];
  types = {} as Record<string, unknown>;
  constructor(t: Record<string, Table>) {
    this.tables = Object.entries(t).map(([name, tb]) => ({ name, columns: Object.keys(tb.cols).map((n) => ({ name: n })) }));
  }
}
