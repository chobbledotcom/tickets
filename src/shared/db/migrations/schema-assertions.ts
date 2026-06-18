type LiveTables = {
  tables: Map<string, Set<string>>;
};

type ColumnAssertionKind = "appSchema" | "legacy" | "migration";

const columnList = (columns: string[]): string => columns.join(", ");

const missingColumns = (
  existing: Set<string>,
  required: readonly string[],
): string[] => required.filter((col) => !existing.has(col));

const missingTableMessage = (
  kind: ColumnAssertionKind,
  table: string,
): string => {
  if (kind === "appSchema") {
    return `Database schema verification failed: missing table ${table}`;
  }
  if (kind === "migration") {
    return `Migration verification failed: missing table ${table}`;
  }
  return `Cannot migrate ${table}: missing expected legacy table`;
};

const missingColumnsMessage = (
  kind: ColumnAssertionKind,
  table: string,
  missing: string[],
): string => {
  if (kind === "appSchema") {
    return `Database schema verification failed: ${table} missing column(s): ${columnList(
      missing,
    )}`;
  }
  if (kind === "migration") {
    return `Migration verification failed: ${table} missing column(s): ${columnList(
      missing,
    )}`;
  }
  return `Cannot migrate ${table}: missing expected legacy column(s): ${columnList(
    missing,
  )}`;
};

export const assertColumnsPresent = (
  kind: ColumnAssertionKind,
  table: string,
  existing: Set<string>,
  required: readonly string[],
): void => {
  const missing = missingColumns(existing, required);
  if (missing.length > 0) {
    throw new Error(missingColumnsMessage(kind, table, missing));
  }
};

export const assertLiveTableColumns = (
  kind: ColumnAssertionKind,
  live: LiveTables,
  table: string,
  required: readonly string[],
): void => {
  const existing = live.tables.get(table);
  if (!existing) throw new Error(missingTableMessage(kind, table));
  assertColumnsPresent(kind, table, existing, required);
};
