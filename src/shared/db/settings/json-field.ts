/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { resultRows, type SqlStatement, withTransaction } from "#db/client.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { syncStoredSetting } from "#db/settings/raw-writes.ts";
import {
  type StringSettingKey,
  setSnapshotField,
} from "#db/settings/snapshot.ts";

/* jscpd:ignore-end */

const StoredJsonSchema = v.object({ value: v.string() });

const parseStoredJson = (row: unknown): string =>
  v.parse(StoredJsonSchema, row).value;

export interface BooleanJsonField {
  statement: (whenSql: string, whenArgs?: readonly InValue[]) => SqlStatement;
  write: (
    whenSql: string,
    validate: (stored: string) => void,
  ) => Promise<string | null>;
}

/** One boolean field in a stored JSON object, exposed as the same SQL statement
 * for larger transactions and as a complete standalone write. */
export const booleanJsonField = (
  key: StringSettingKey,
  initialValue: string,
  path: string,
  value: boolean,
): BooleanJsonField => {
  const jsonType = value ? "true" : "false";
  const statement = (
    whenSql: string,
    whenArgs: readonly InValue[] = [],
  ): SqlStatement => ({
    args: [
      key,
      initialValue,
      ...whenArgs,
      path,
      jsonType,
      ...whenArgs,
      path,
      jsonType,
    ],
    sql: `INSERT INTO settings (key, value)
        SELECT ?, ?
        WHERE ${whenSql}
        ON CONFLICT(key) DO UPDATE SET
          value = json_set(settings.value, ?, json(?))
        WHERE (${whenSql})
          AND json_type(settings.value, ?) IS NOT ?
        RETURNING value`,
  });

  const write = async (
    whenSql: string,
    validate: (stored: string) => void,
  ): Promise<string | null> => {
    const stored = await withTransaction(async (tx) => {
      const result = await tx.execute(statement(whenSql));
      const [returned] = resultRows<unknown>(result);
      if (returned === undefined) {
        const currentResult = await tx.execute({
          args: [key, path, jsonType],
          sql: `SELECT value FROM settings
                WHERE key = ? AND json_type(value, ?) = ?`,
        });
        const [current] = resultRows<unknown>(currentResult);
        if (current === undefined) return null;
        const unchanged = parseStoredJson(current);
        validate(unchanged);
        return unchanged;
      }
      const next = parseStoredJson(returned);
      validate(next);
      await tx.execute(settingsVersionIncrement());
      return next;
    });
    if (stored === null) return null;
    syncStoredSetting(key, (values) => values.set(key, stored));
    setSnapshotField(key, stored);
    return stored;
  };

  return { statement, write };
};
