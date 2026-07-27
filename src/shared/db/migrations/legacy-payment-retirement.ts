import type { Client } from "@libsql/client";
import type { SqlStatement } from "#shared/db/client.ts";
import {
  LEGACY_PAYMENT_TABLE_NAMES,
  type LegacyPaymentTableName,
  namesInMigrationResult,
} from "./legacy-payment-schema.ts";

const operations = ["insert", "update"] as const;

const blockerName = (
  table: LegacyPaymentTableName,
  operation: (typeof operations)[number],
): string => `payment_aggregate_block_${table}_${operation}`;

type LegacyPaymentSourceAction = (
  getDb: () => Client,
  existing: ReadonlySet<LegacyPaymentTableName>,
) => Promise<void>;

const withExistingLegacyTables =
  (
    action: (
      getDb: () => Client,
      tables: readonly LegacyPaymentTableName[],
    ) => Promise<void>,
  ): LegacyPaymentSourceAction =>
  (getDb, existing) =>
    action(
      getDb,
      LEGACY_PAYMENT_TABLE_NAMES.filter((table) => existing.has(table)),
    );

export const existingLegacyPaymentTables = async (
  getDb: () => Client,
): Promise<Set<LegacyPaymentTableName>> => {
  const result = await getDb().execute({
    args: LEGACY_PAYMENT_TABLE_NAMES,
    sql: `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN (${LEGACY_PAYMENT_TABLE_NAMES.map(() => "?").join(", ")})`,
  });
  const existing = namesInMigrationResult(result);
  return new Set(
    LEGACY_PAYMENT_TABLE_NAMES.filter((name) => existing.has(name)),
  );
};

export const blockLegacyPaymentWrites: LegacyPaymentSourceAction =
  withExistingLegacyTables(async (getDb, tables) => {
    const sql = tables.flatMap((table) =>
      operations.map(
        (operation) =>
          `CREATE TRIGGER IF NOT EXISTS ${blockerName(table, operation)}
          BEFORE ${operation.toUpperCase()} ON ${table}
          BEGIN SELECT RAISE(ABORT, 'legacy payment source is closed'); END`,
      ),
    );
    if (sql.length > 0) await getDb().executeMultiple(`${sql.join(";\n")};`);
  });

export const assertLegacyPaymentSourcesDrained: LegacyPaymentSourceAction =
  withExistingLegacyTables(async (getDb, tables) => {
    if (tables.length === 0) return;
    const result = await getDb().execute(
      `SELECT ${tables
        .map((table) => `(SELECT COUNT(*) FROM ${table})`)
        .join(" + ")} AS remaining`,
    );
    if (Number(result.rows[0]?.remaining) !== 0) {
      throw new Error("Legacy payment sources were not fully drained");
    }
  });

export const dropLegacyPaymentSources = async (
  getDb: () => Client,
): Promise<void> => {
  const statements: SqlStatement[] = LEGACY_PAYMENT_TABLE_NAMES.map(
    (table) => ({
      args: [],
      sql: `DROP TABLE IF EXISTS ${table}`,
    }),
  );
  await getDb().batch(statements, "write");
};
