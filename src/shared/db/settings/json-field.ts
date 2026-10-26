import * as v from "valibot";
import { resultRows, type SqlStatement, withTransaction } from "#db/client.ts";
import {
  numberedStatement,
  type SqlParameter,
} from "#db/numbered-statement.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { syncStoredSetting } from "#db/settings/raw-writes.ts";
import {
  type StringSettingKey,
  setSnapshotField,
} from "#db/settings/snapshot.ts";

const StoredJsonSchema = v.object({ value: v.string() });

const parseStoredJson = (row: unknown): string =>
  v.parse(StoredJsonSchema, row).value;

/** The condition a feature write keeps true on both passes. The builder binds
 * the clause's own values, and both passes read the same tokens, so a value
 * the clause needs twice is bound once. */
export type WhenClause = (bind: SqlParameter) => string;

export interface BooleanJsonField {
  statement: (when: WhenClause) => SqlStatement;
  write: (
    when: WhenClause,
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
  const statement = (when: WhenClause): SqlStatement =>
    numberedStatement((bind) => {
      const clause = when(bind);
      return `INSERT INTO settings (key, value)
        SELECT ${bind(key)}, ${bind(initialValue)}
        WHERE ${clause}
        ON CONFLICT(key) DO UPDATE SET
          value = json_set(settings.value, ${bind(path)}, json(${bind(jsonType)}))
        WHERE (${clause})
          AND json_type(settings.value, ${bind(path)}) IS NOT ${bind(jsonType)}
        RETURNING value`;
    });

  const write = async (
    when: WhenClause,
    validate: (stored: string) => void,
  ): Promise<string | null> => {
    const stored = await withTransaction(async (tx) => {
      const result = await tx.execute(statement(when));
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
