export interface QueryColumn {
  name: string;
  type?: string;
}

export interface QueryResult {
  rows: ReadonlyArray<Record<string, unknown>>;
  columns: ReadonlyArray<QueryColumn>;
  generatedAt: string;
  fromCache?: boolean;
}
