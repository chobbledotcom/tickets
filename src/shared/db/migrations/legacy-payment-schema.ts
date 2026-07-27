import type { Client, ResultSet } from "@libsql/client";
import type { SqlStatement } from "#shared/db/client.ts";
import type {
  MigrationBuilder,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";

type LegacyTable = {
  columns: readonly [name: string, definition: string][];
  indexes: readonly [name: string, sql: string][];
};

const LEGACY_PAYMENT_TABLES = {
  checkout_stages: {
    columns: [
      ["payment_session_id", "TEXT PRIMARY KEY NOT NULL"],
      ["attendee_id", "INTEGER NOT NULL"],
      ["provider", "TEXT NOT NULL"],
      ["ticket_tokens", "TEXT NOT NULL"],
      ["state", "TEXT NOT NULL"],
      ["created_at", "TEXT NOT NULL"],
    ],
    indexes: [
      [
        "idx_checkout_stages_attendee_id",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_stages_attendee_id ON checkout_stages(attendee_id)",
      ],
      [
        "idx_checkout_stages_state_created_at",
        "CREATE INDEX IF NOT EXISTS idx_checkout_stages_state_created_at ON checkout_stages(state, created_at)",
      ],
    ],
  },
  processed_payments: {
    columns: [
      ["payment_session_id", "TEXT PRIMARY KEY"],
      ["attendee_id", "INTEGER"],
      ["processed_at", "TEXT NOT NULL"],
      ["ticket_tokens", "TEXT NOT NULL DEFAULT ''"],
      ["failure_data", "TEXT NOT NULL DEFAULT ''"],
      ["payment_reference", "TEXT NOT NULL DEFAULT ''"],
      ["provider_refunded_at", "TEXT NOT NULL DEFAULT ''"],
    ],
    indexes: [
      [
        "idx_processed_payments_attendee_id",
        "CREATE INDEX IF NOT EXISTS idx_processed_payments_attendee_id ON processed_payments(attendee_id, payment_reference)",
      ],
    ],
  },
  sumup_checkouts: {
    columns: [
      ["reference_index", "TEXT PRIMARY KEY"],
      ["wrapped_key", "TEXT NOT NULL DEFAULT ''"],
      ["metadata", "TEXT NOT NULL"],
      ["sumup_id", "TEXT NOT NULL DEFAULT ''"],
      ["created_at", "TEXT NOT NULL"],
    ],
    indexes: [
      [
        "idx_sumup_checkouts_sumup_id",
        "CREATE INDEX IF NOT EXISTS idx_sumup_checkouts_sumup_id ON sumup_checkouts(sumup_id)",
      ],
    ],
  },
} as const satisfies Record<string, LegacyTable>;

export type LegacyPaymentTableName = keyof typeof LEGACY_PAYMENT_TABLES;

export const LEGACY_PAYMENT_TABLE_NAMES: LegacyPaymentTableName[] = [
  "processed_payments",
  "checkout_stages",
  "sumup_checkouts",
];

const tableSql = (name: LegacyPaymentTableName): string =>
  `CREATE TABLE IF NOT EXISTS ${name} (${LEGACY_PAYMENT_TABLES[name].columns
    .map(([column, definition]) => `${column} ${definition}`)
    .join(", ")})`;

/** The CREATE statements that build one old payment table and its indexes. */
export const legacyPaymentTableStatements = (
  name: LegacyPaymentTableName,
): SqlStatement[] => [
  { args: [], sql: tableSql(name) },
  ...LEGACY_PAYMENT_TABLES[name].indexes.map(([, sql]) => ({ args: [], sql })),
];

export const namesInMigrationResult = (result: ResultSet): Set<string> =>
  new Set(result.rows.map((row) => String(row.name)));

const legacyColumnNames = async (
  getDb: () => Client,
  name: string,
): Promise<Set<string>> =>
  namesInMigrationResult(await getDb().execute(`PRAGMA table_info(${name})`));

export const legacyPaymentRestoreStatements = (
  dumpStatements: readonly string[],
): string[] => {
  const dumped = new Set(
    dumpStatements.flatMap((statement) => {
      const table = /^INSERT\s+INTO\s+"?(\w+)"?\s*\(/iu.exec(statement)?.[1];
      return table !== undefined &&
        LEGACY_PAYMENT_TABLE_NAMES.includes(table as LegacyPaymentTableName)
        ? [table as LegacyPaymentTableName]
        : [];
    }),
  );
  return LEGACY_PAYMENT_TABLE_NAMES.filter((name) => dumped.has(name)).flatMap(
    (name) =>
      legacyPaymentTableStatements(name).map((statement) => statement.sql),
  );
};

type LegacyRequirementAction = (
  getDb: () => Client,
  requirement: SchemaRequirement,
) => Promise<void>;

type ResolvedLegacyRequirementAction = (
  getDb: () => Client,
  requirement: SchemaRequirement,
  name: LegacyPaymentTableName,
) => Promise<void>;

const withLegacyTable =
  (action: ResolvedLegacyRequirementAction): LegacyRequirementAction =>
  (getDb, requirement) =>
    action(getDb, requirement, legacyTableNameFor(requirement));

const verifyLegacyRequirement = withLegacyTable(
  async (getDb, requirement, retiredTable): Promise<void> => {
    const [tables, indexes] = await getDb().batch(
      [
        {
          args: [],
          sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
        },
        {
          args: [],
          sql: "SELECT name FROM sqlite_master WHERE type = 'index'",
        },
      ],
      "read",
    );
    const tableNames = namesInMigrationResult(tables!);
    const indexNames = namesInMigrationResult(indexes!);
    if (!tableNames.has(retiredTable)) return;
    assertLegacyNamesPresent("table", requirement.newTables, tableNames);
    assertLegacyNamesPresent("index", requirement.indexes, indexNames);
    await Promise.all(
      Object.entries(requirement.columns ?? {}).map(([name, columns]) =>
        verifyLegacyColumns(getDb, name, columns),
      ),
    );
  },
);

const assertLegacyNamesPresent = (
  kind: "index" | "table",
  names: readonly string[] | undefined,
  existing: ReadonlySet<string>,
): void => {
  const missing = (names ?? []).find((name) => !existing.has(name));
  if (missing !== undefined)
    throw new Error(`Missing legacy ${kind} ${missing}`);
};

const verifyLegacyColumns = async (
  getDb: () => Client,
  name: string,
  columns: readonly string[],
): Promise<void> => {
  const existing = await legacyColumnNames(getDb, name);
  const missing = columns.find((column) => !existing.has(column));
  if (missing !== undefined) {
    throw new Error(`Missing legacy column ${name}.${missing}`);
  }
};

function legacyTableNameFor(
  requirement: SchemaRequirement,
): LegacyPaymentTableName {
  const name =
    requirement.newTables?.[0] ??
    Object.keys(requirement.columns ?? {})[0] ??
    LEGACY_PAYMENT_TABLE_NAMES.find((table) =>
      LEGACY_PAYMENT_TABLES[table].indexes.some(([index]) =>
        requirement.indexes?.includes(index),
      ),
    );
  if (name === undefined || !(name in LEGACY_PAYMENT_TABLES)) {
    throw new Error("Historical payment migration has no legacy table");
  }
  return name as LegacyPaymentTableName;
}

const addLegacyColumns = async (
  getDb: () => Client,
  name: LegacyPaymentTableName,
  columns: readonly string[],
): Promise<void> => {
  const table = LEGACY_PAYMENT_TABLES[name];
  const existing = await legacyColumnNames(getDb, name);
  for (const column of columns) {
    if (existing.has(column)) continue;
    const definition = table.columns.find(
      ([candidate]) => candidate === column,
    )?.[1];
    if (definition === undefined) {
      throw new Error(`Unknown legacy column ${name}.${column}`);
    }
    await getDb().execute(
      `ALTER TABLE ${name} ADD COLUMN ${column} ${definition}`,
    );
  }
};

const addLegacyIndexes = async (
  getDb: () => Client,
  name: LegacyPaymentTableName,
  indexes: readonly string[],
): Promise<void> => {
  const required = new Set(indexes);
  const statements = LEGACY_PAYMENT_TABLES[name].indexes
    .filter(([index]) => required.has(index))
    .map(([, sql]) => ({ args: [], sql }));
  if (statements.length > 0) await getDb().batch(statements, "write");
};

const applyLegacyRequirement = withLegacyTable(
  async (getDb, requirement, name): Promise<void> => {
    await getDb().execute(tableSql(name));
    await addLegacyColumns(getDb, name, requirement.columns?.[name] ?? []);
    await addLegacyIndexes(getDb, name, requirement.indexes ?? []);
  },
);

/** Historical declarations own their retired table shape without consulting SCHEMA. */
export const legacyPaymentSchemaMigration =
  (
    id: string,
    description: string,
    requirement: SchemaRequirement,
  ): MigrationBuilder =>
  ({ getDb }) => ({
    description,
    id,
    requires: requirement,
    up: () => applyLegacyRequirement(getDb, requirement),
    verify: () => verifyLegacyRequirement(getDb, requirement),
  });
