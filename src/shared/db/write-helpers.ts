import type { ResultSet } from "@libsql/client";
import { resultRows, type SqlStatement } from "#shared/db/client.ts";

export type TimedRowWrite<Row, Result> = (
  rows: readonly Row[],
  observedAt?: number,
) => Promise<Result>;

/** Run a list write at an explicit time, or at the current time by default. */
export const writeRowsAtCurrentTime =
  <Row, Result>(
    write: (rows: readonly Row[], observedAt: number) => Promise<Result>,
  ): TimedRowWrite<Row, Result> =>
  (rows, observedAt = Date.now()) =>
    write(rows, observedAt);

/** Require a batch statement to return exactly the expected rows. */
export const requireReturnedRows =
  <Row>(expectedCount: number, message: string) =>
  (result: ResultSet | undefined): Row[] => {
    if (result === undefined) throw new Error(message);
    const rows = resultRows<Row>(result);
    if (rows.length !== expectedCount) throw new Error(message);
    return rows;
  };

/** Roll back the current batch unless the previous statement changed one row. */
export const requirePreviousWrite = (): SqlStatement => ({
  args: [1],
  sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
        SELECT NULL, NULL, 1 WHERE changes() != ?`,
});
