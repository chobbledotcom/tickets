/** The listing fields trim migration: every stored contact-fields string is
 *  rewritten as the trimmed, comma-joined tokens the parser reads. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, resultRows } from "#db/client.ts";
import listingFieldsTrimMigration from "#db/migrations/2026-10-12_listing_fields_trim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

type ListingRow = { fields: string; id: number };

const listingFieldRows = async (): Promise<ListingRow[]> =>
  resultRows(await getDb().execute("SELECT id, fields FROM listings"));

const insertListingFields = async (fields: string): Promise<number> => {
  const result = await getDb().execute({
    args: [new Date().toISOString(), 10, fields],
    sql: "INSERT INTO listings (created, max_attendees, fields) VALUES (?, ?, ?)",
  });
  return Number(result.lastInsertRowid);
};

describeWithEnv("listing fields trim migration", { db: true }, () => {
  test("trims padded tokens, drops blanks, and leaves stored rows", async () => {
    const padded = await insertListingFields("phone, email");
    const narrow = await insertListingFields("\u00a0email\u00a0");
    const doubled = await insertListingFields("email,,phone");
    const stored = await insertListingFields("email,phone");

    await listingFieldsTrimMigration(buildMigrationContext()).up();

    const rows = new Map(
      (await listingFieldRows()).map((row) => [row.id, row.fields]),
    );
    expect(rows.get(padded)).toBe("phone,email");
    expect(rows.get(narrow)).toBe("email");
    expect(rows.get(doubled)).toBe("email,phone");
    // An already-stored row keeps its value, so the rewrite is idempotent.
    expect(rows.get(stored)).toBe("email,phone");
  });
});
