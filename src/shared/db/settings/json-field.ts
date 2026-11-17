import * as v from "valibot";
import { resultRows, withTransaction } from "#db/client.ts";
import { and, valued } from "#db/select/expression.ts";
import {
  settingRewrite,
  settingsVersionIncrement,
} from "#db/settings/cache.ts";
import { publishStoredSetting } from "#db/settings/raw-writes.ts";
import type { StringSettingKey } from "#db/settings/snapshot.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

const StoredJsonSchema = v.object({ value: v.string() });

const parseStoredJson = (row: unknown): string =>
  v.parse(StoredJsonSchema, row).value;

export interface BooleanJsonField {
  statement: (when: SqlStatement) => SqlStatement;
  write: (
    when: SqlStatement,
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
  /** `when` is the condition the write keeps true on both passes. */
  const statement = (when: SqlStatement): SqlStatement => {
    const holds = valued<boolean>(when);
    return settingRewrite(
      key,
      initialValue,
      (stored) => sql`json_set(${stored}, ${path}, json(${jsonType}))`,
      {
        when: holds,
        where: (row) =>
          and(
            holds,
            valued(sql`json_type(${row.value}, ${path}) IS NOT ${jsonType}`),
          ),
      },
    ).returning("value");
  };

  const write = async (
    when: SqlStatement,
    validate: (stored: string) => void,
  ): Promise<string | null> => {
    // jscpd:ignore-start — the shared shape is withTransaction's own
    // invocation shell. The bodies are two different compare-and-swap paths.
    const stored = await withTransaction(async (tx) => {
      const result = await tx.execute(statement(when));
      // jscpd:ignore-end
      const [returned] = resultRows<unknown>(result);
      if (returned === undefined) {
        const currentResult = await tx.execute(sql`SELECT value FROM settings
                WHERE key = ${key} AND json_type(value, ${path}) = ${jsonType}`);
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
    publishStoredSetting(key, stored);
    return stored;
  };

  return { statement, write };
};
