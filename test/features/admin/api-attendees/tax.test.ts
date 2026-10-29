import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { accountBalance } from "#accounting/queries.ts";
import { getAttendeeRaw } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { account } from "#shared/ledger/account.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("Admin API booking tax", { db: true }, () => {
  test("returns and stores the full balance with added tax", async () => {
    await settings.update.tax({ mode: "add_to_total", rateBasisPoints: 2000 });
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Tax fair",
      unitPrice: 1000,
    });
    const created = await assertJson(createBooking(listing.id), 201, (body) =>
      expect(body.attendee.remaining_balance).toBe(1200),
    );
    expect(await getAttendeeRaw(created.attendee.id)).toMatchObject({
      remaining_balance: 1200,
    });
    expect(await accountBalance(account("attendee", created.attendee.id))).toBe(
      -1200,
    );
    expect(await accountBalance(account("tax", "vat"))).toBe(200);
  });
});
