/** Deletion for listings: the listing row and every record owned by it. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteListing } from "#db/listings/delete.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { createOwnerNote, getNoteRows } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > listings > delete", { db: true }, () => {
  test("deletes the listing's notes with the listing", async () => {
    const listing = await createTestListing({ name: "Noted delete" });
    await createOwnerNote(
      noteTargets.of("listing")(listing.id),
      "a note on this listing",
    );

    await deleteListing(listing.id);

    expect(await getListingWithCount(listing.id)).toBeNull();
    expect(await getNoteRows("listing", [listing.id])).toEqual([]);
  });
});
