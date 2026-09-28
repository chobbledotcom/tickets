import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import checkedInCount from "#db/migrations/2026-09-27_checked_in_count.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({});
const migration = () => checkedInCount(context);

/** One booking line holding `quantity` places with the old flag stored. */
const lineWith = async (
  id: number,
  quantity: number,
  flag: number,
): Promise<void> => {
  await getDb().execute(
    `INSERT INTO attendees (id, created, kind) VALUES (${id}, '2026-09-27T00:00:00Z', 'attendee')`,
  );
  await getDb().execute(
    `INSERT INTO listing_attendees (attendee_id, listing_id, quantity, checked_in) VALUES (${id}, 1, ${quantity}, ${flag})`,
  );
};

/** The count the line now stores. */
const storedCount = async (attendeeId: number): Promise<number> =>
  Number(
    (
      await getDb().execute(
        "SELECT checked_in FROM listing_attendees WHERE attendee_id = ?",
        [attendeeId],
      )
    ).rows[0]?.checked_in,
  );

describeWithEnv("db > migrations > checked_in count", { db: true }, () => {
  test("a stored 1 becomes the line's quantity, and everything else stays", async () => {
    await lineWith(901, 4, 1);
    await lineWith(902, 3, 0);
    await lineWith(903, 0, 0);

    await migration().up();

    // The old flag could not record less than the whole line, so a stored 1
    // meant every place arrived.
    expect(await storedCount(901)).toBe(4);
    expect(await storedCount(902)).toBe(0);
    expect(await storedCount(903)).toBe(0);
  });

  test("a ghost row never gains a count", async () => {
    await lineWith(904, 0, 1);

    await migration().up();

    expect(await storedCount(904)).toBe(0);
  });

  test("running it twice changes nothing the second time", async () => {
    await lineWith(905, 2, 1);

    await migration().up();
    await migration().up();

    expect(await storedCount(905)).toBe(2);
  });

  test("declares every object it owns", () => {
    // Anything left off this list is never verified, so a partial upgrade
    // would record itself as applied.
    expect(migration().id).toBe("2026-09-27_checked_in_count");
    expect(migration().requires).toEqual({});
    expect(migration().description).toBe(
      "checked_in becomes a count of admitted tickets, 0..quantity, instead of " +
        "a 0/1 flag. A line an operator marked as arrived held its full quantity " +
        "in practice, because the flag could not record less, so every stored 1 " +
        "becomes the row's quantity. Ghost rows (quantity 0) and never-checked " +
        "rows keep 0. The statement is idempotent: after it runs, no row with a " +
        "quantity above 1 still stores 1. The count writers and readers land in " +
        "the same build, so nothing reads a count as a flag.",
    );
  });
});
