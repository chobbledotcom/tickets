import { execute } from "#db/client.ts";

/** Make every sort_order write on the table fail, run the work, then clean up.
 * The rollback tests use this to prove an insert and its order write commit
 * or vanish together. */
export const withFailingOrderTrigger = async (
  table: "answers" | "attribute_options" | "attributes" | "questions",
  run: () => Promise<void>,
): Promise<void> => {
  await execute(`
    CREATE TRIGGER fail_${table}_order
    BEFORE UPDATE OF sort_order ON ${table}
    BEGIN
      SELECT RAISE(ABORT, 'order write failed');
    END
  `);
  try {
    await run();
  } finally {
    await execute(`DROP TRIGGER IF EXISTS fail_${table}_order`);
  }
};
