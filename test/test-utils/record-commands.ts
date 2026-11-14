import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { WriteVerdict } from "#shared/rest/record-contract.ts";
import { loggedMessages } from "#test-utils/activity-log.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";

/** An id that no test row holds. */
const MISSING_ID = 999;

/** The two record commands a delete check calls. */
type DeletableRecord = {
  load: (id: number) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
};

/** Delete one row through its record, then check the row is gone and the
 *  activity log holds these lines, newest first. */
export const expectRecordDelete = async (
  record: DeletableRecord,
  id: number,
  messages: readonly string[],
): Promise<void> => {
  expect(await record.remove(id)).toEqual({ kind: "deleted" });
  expect(await record.load(id)).toBe(null);
  expect(await loggedMessages()).toEqual(messages);
};

/** Create one row through its record, delete it, and check the activity log
 *  holds these lines, newest first. */
export const expectCreateThenDelete = async <Input>(
  record: DeletableRecord & {
    create: (input: Input) => Promise<WriteVerdict<{ id: number }>>;
  },
  input: Input,
  messages: readonly string[],
): Promise<void> => {
  const { id } = await writtenRow(record.create(input));
  await expectRecordDelete(record, id, messages);
};

/** Check one write answered with this row and the activity log holds these
 *  lines, newest first. */
export const expectWrittenAndLogged = async (
  verdict: Promise<unknown>,
  row: Record<string, unknown>,
  messages: readonly string[],
): Promise<void> => {
  expect(await verdict).toMatchObject({ kind: "written", row });
  expect(await loggedMessages()).toEqual(messages);
};

/** Check one command was refused with this message. */
export const expectRefused = async (
  verdict: Promise<unknown>,
  message: string,
): Promise<void> => {
  expect(await verdict).toEqual({ kind: "refused", message });
};

/** Declare the test that an update of an id no row holds answers not-found. */
export const testMissingUpdate = <Input>(
  record: { update: (id: number, input: Input) => Promise<unknown> },
  input: Input,
): void => {
  test("answers not-found for an update of a missing row", async () => {
    expect(await record.update(MISSING_ID, input)).toEqual({
      kind: "not-found",
    });
  });
};

/** Check an update answers not-found when this delete runs just before its
 *  write transaction opens. */
export const expectNotFoundAfterRacingDelete = async (
  deleteFirst: () => Promise<unknown>,
  update: () => Promise<unknown>,
): Promise<void> => {
  const restore = beforeNextTransaction(async () => {
    await deleteFirst();
  });
  try {
    expect(await update()).toEqual({ kind: "not-found" });
  } finally {
    restore();
  }
};

/** The row one write stored. A write the test expects to pass throws when
 *  it does not store its row. */
export const writtenRow = async <Row>(
  verdict: Promise<WriteVerdict<Row>>,
): Promise<Row> => {
  const answer = await verdict;
  expect(answer.kind).toBe("written");
  return (answer as Extract<WriteVerdict<Row>, { kind: "written" }>).row;
};

/** The names a record lists, in the order it lists them. */
export const listedNames = async (record: {
  getAll: () => Promise<readonly { name: string }[]>;
}): Promise<string[]> => (await record.getAll()).map((row) => row.name);
