import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { insert } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import { initDb } from "#shared/db/migrations.ts";
import {
  createLegacyMigrationHarness,
  stubPragmaForeignKeysOff,
} from "#test/lib/db/legacy-migration/helpers.ts";

describe("db > listing_attendees migration from legacy schema (questions)", () => {
  const h = createLegacyMigrationHarness();
  afterEach(h.cleanup);

  test("adds question display type when legacy question tables have foreign keys", async () => {
    const client = await h.createLegacyDbWithListing();
    await client.execute(
      insert("questions", {
        id: 1,
        text: "Encrypted question",
      }),
    );
    await client.execute(
      insert("answers", {
        id: 1,
        question_id: 1,
        text: "Encrypted answer",
      }),
    );
    await client.execute(
      insert("listing_questions", {
        id: 1,
        listing_id: 1,
        question_id: 1,
      }),
    );

    using _pragmaStub = stubPragmaForeignKeysOff(client);
    await initDb();

    const questions = await client.execute(
      "SELECT id, text, sort_order, display_type FROM questions",
    );
    expect(questions.rows.length).toBe(1);
    expect(questions.rows[0]!.display_type).toBe("radio");
    expect(questions.rows[0]!.id).toBe(1);
    expect(questions.rows[0]!.text).toBe("Encrypted question");

    const answers = await client.execute(
      "SELECT id, question_id, text FROM answers",
    );
    expect(answers.rows).toEqual([
      { id: 1, question_id: 1, text: "Encrypted answer" },
    ]);
  });

  test("deletes a migrated listing and its question links under FK enforcement", async () => {
    const client = await h.createLegacyDbWithListing();
    await client.execute(insert("questions", { id: 1, text: "Encrypted" }));
    await client.execute(
      insert("listing_questions", { id: 1, listing_id: 1, question_id: 1 }),
    );

    using _pragmaStub = stubPragmaForeignKeysOff(client);
    await initDb();

    // The free-text migration rebuilds listing_questions FK-free (so the
    // questions table it references can itself be rebuilt to relax the
    // display_type CHECK). deleteListing still clears the link rows as part of
    // its cascade, so — even with FK enforcement on, as on the Turso primary —
    // deleting a listing with an assigned question succeeds and leaves no
    // orphaned links.
    await deleteListing(1);

    const listings = await client.execute("SELECT id FROM listings");
    expect(listings.rows.length).toBe(0);
    const links = await client.execute("SELECT id FROM listing_questions");
    expect(links.rows.length).toBe(0);
  });
});
