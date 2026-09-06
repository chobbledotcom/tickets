import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  prepareTestOrder,
  quantityForm,
  ticketContext,
} from "#test-utils/ticket-ctx.ts";

describeWithEnv("ticket preparation fixtures", { db: true }, () => {
  test("reports the real refusal when a fixture selects no tickets", async () => {
    const listing = await createTestListing();
    const ctx = await ticketContext([listing.id]);
    await expect(
      prepareTestOrder(ctx, quantityForm({ [listing.id]: 0 })),
    ).rejects.toThrow(
      "prepareOrder refused: Please select at least one ticket",
    );
  });
});
