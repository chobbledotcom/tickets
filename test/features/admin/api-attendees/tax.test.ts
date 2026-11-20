import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { getAttendeeRaw } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { account } from "#shared/ledger/account.ts";
import { readTaxAssessments } from "#shared/tax/store.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
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

  test("taxes a taxable adjustment with the lines and keeps the others outside", async () => {
    await settings.update.tax({ mode: "add_to_total", rateBasisPoints: 2000 });
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Taxed delivery fair",
      unitPrice: 134000,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        adjustments: [
          { amount: 4560, description: "Card fee", taxable: true },
          { amount: 18000, description: "Delivery", taxable: true },
          { amount: -1000, description: "Goodwill" },
          { amount: 500, description: "Untaxed charge" },
        ],
      }),
      201,
      // 134000 + 4560 + 18000 = 156560 net. Tax is 31312. The total is
      // 187872. The writeoff and the untaxed charge add -500.
      (body) => expect(body.attendee.remaining_balance).toBe(187372),
    );
    const id = created.attendee.id as number;
    expect(await accountBalance(account("attendee", id))).toBe(-187372);
    expect(await accountBalance(account("tax", "vat"))).toBe(31312);
    const [stored] = await readTaxAssessments([id]);
    expect(stored!.state.assessment).toMatchObject({
      basis: {
        charges: [{ gross: 4560 }, { gross: 18000 }],
        lines: [{ gross: 134000 }],
      },
      taxAmount: 31312,
      taxableTotal: 156560,
      total: 187872,
    });
    const charges = (await transfersByAccount(account("attendee", id)))
      .filter((leg) => leg.kind === "manual_attendee_charge")
      .map((leg) => leg.amount);
    expect(charges).toEqual([4560, 18000, 500]);
  });

  test("takes the tax out of a taxable adjustment when prices include tax", async () => {
    await settings.update.tax({
      mode: "calculate_from_total",
      rateBasisPoints: 2000,
    });
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Included delivery fair",
      unitPrice: 10000,
    });
    const created = await assertJson(
      createBooking(listing.id, {
        adjustments: [{ amount: 2000, description: "Delivery", taxable: true }],
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(12000),
    );
    const id = created.attendee.id as number;
    const legs = await transfersByAccount(account("attendee", id));
    // 2000 of tax sits inside 12000. The delivery carries 333 of it.
    expect(
      legs.find((leg) => leg.kind === "manual_attendee_charge")?.amount,
    ).toBe(1667);
    expect(await accountBalance(account("attendee", id))).toBe(-12000);
    expect(await accountBalance(account("tax", "vat"))).toBe(2000);
  });

  test("a taxable adjustment adds nothing when the site charges no tax", async () => {
    await settings.update.tax({ mode: "none" });
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Untaxed delivery fair",
      unitPrice: 1000,
    });
    await assertJson(
      createBooking(listing.id, {
        adjustments: [{ amount: 250, description: "Delivery", taxable: true }],
      }),
      201,
      (body) => expect(body.attendee.remaining_balance).toBe(1250),
    );
  });

  test("refuses a taxable writeoff and a taxable value that is not true or false", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Taxable refusals",
      unitPrice: 1000,
    });
    await expectApiError(
      createBooking(listing.id, {
        adjustments: [{ amount: -100, description: "Goodwill", taxable: true }],
      }),
      400,
      "adjustments[0].taxable only applies to a charge, not a writeoff",
    );
    await expectApiError(
      createBooking(listing.id, {
        adjustments: [{ amount: 100, description: "Fee", taxable: "yes" }],
      }),
      400,
      "adjustments[0].taxable must be true or false",
    );
  });
});
