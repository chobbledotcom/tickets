import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { sql } from "#db/sql.ts";

/** Assert that attendee `id` is the only match and that its row holds each
 *  expected column value. */
export const expectAttendeeRow = async (
  client: Client,
  id: number,
  expected: Record<string, string>,
): Promise<void> => {
  const rows = await client.execute(
    sql`SELECT * FROM attendees WHERE id = ${id}`,
  );
  expect(rows.rows.length).toBe(1);
  for (const [column, value] of Object.entries(expected)) {
    expect(rows.rows[0]![column]).toBe(value);
  }
};
