import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeRemovalStatements } from "#db/attendees/delete.ts";
import { ATTENDEE_DATA_RULES } from "#db/attendees/dependent-data.ts";
import { APP_SCHEMA } from "#db/migrations/schema/index.ts";
import { paymentTables } from "#db/migrations/schema/payments/index.ts";

const tableColumns = new Map(
  APP_SCHEMA.map(([name, table]) => [
    name,
    new Set(table.columns.map(([column]) => column)),
  ]),
);

const requireColumns = (table: string): Set<string> => {
  const columns = tableColumns.get(table);
  if (columns === undefined) {
    throw new Error(`Schema table ${table} is missing`);
  }
  return columns;
};

const directAttendeeFields = APP_SCHEMA.flatMap(([table, definition]) =>
  definition.columns
    .map(([field]) => field)
    .filter((field) => /attendee_id$/.test(field))
    .map((field) => `${table}.${field}`),
).sort();

describe("attendee dependent data", () => {
  test("classifies every schema column that names an attendee", () => {
    const classified = ATTENDEE_DATA_RULES.flatMap((rule) =>
      rule.kind === "direct" ? [`${rule.table}.${rule.field}`] : [],
    ).sort();

    expect(classified).toEqual(directAttendeeFields);
  });

  test("classifies every durable payment table, including indirect children", () => {
    const paymentTableNames = paymentTables.map(([name]) => name).sort();
    const paymentNames = new Set(paymentTableNames);
    const classified = ATTENDEE_DATA_RULES.filter((rule) =>
      paymentNames.has(rule.table),
    )
      .map((rule) => rule.table)
      .sort();

    expect(classified).toEqual(paymentTableNames);
  });

  test("points every deletion rule at real schema columns", () => {
    for (const rule of ATTENDEE_DATA_RULES) {
      const columns = requireColumns(rule.table);
      if (rule.kind === "direct") {
        expect(columns.has(rule.field)).toBe(true);
      } else if (rule.kind === "through") {
        expect(columns.has(rule.tableField)).toBe(true);
        const joinedColumns = requireColumns(rule.joinedTable);
        expect(joinedColumns.has(rule.joinedField)).toBe(true);
        expect(joinedColumns.has(rule.attendeeField)).toBe(true);
      } else if (rule.kind === "notes") {
        expect(columns.has("entity_type")).toBe(true);
        expect(columns.has("entity_id")).toBe(true);
      }
    }
  });

  test("deletes joined children before their attendee-owned parent", () => {
    for (const rule of ATTENDEE_DATA_RULES) {
      if (rule.kind !== "through") continue;
      const childIndex = ATTENDEE_DATA_RULES.indexOf(rule);
      const parentIndex = ATTENDEE_DATA_RULES.findIndex(
        (candidate) =>
          candidate.action === "delete" && candidate.table === rule.joinedTable,
      );
      expect(parentIndex).toBeGreaterThan(childIndex);
    }
  });

  test("builds one production change for every non-retained rule", () => {
    const attendeeIds = { args: [12, 13], sql: "SELECT id FROM chosen" };
    const statements = attendeeRemovalStatements(attendeeIds);
    const removalRules = ATTENDEE_DATA_RULES.filter(
      (rule) => rule.action !== "retain",
    );

    expect(statements).toHaveLength(removalRules.length);
    for (const [index, rule] of removalRules.entries()) {
      expect(statements[index]!.args).toEqual(
        rule.kind === "notes" ? ["attendee", ...attendeeIds.args] : [12, 13],
      );
      expect(statements[index]!.sql).toContain(rule.table);
    }
  });
});
