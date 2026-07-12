import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WRITEOFF,
} from "#shared/accounting/accounts.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#shared/accounting/manual-entries.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { expectFlashRedirect, expectRedirect } from "#test-utils/assertions.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale, postModifierLeg } from "#test-utils/ledger.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  completePaidOrder,
  describeAccounting,
  postAttendeeBalanceEntry,
  submitRefund,
  withRefundMock,
} from "./drivers.ts";
import {
  adminPageHtml,
  assertEditPageIncome,
  assertRenderedIncome,
  assertRenderedModifierRevenue,
  assertRenderedOwed,
  assertStatementBalance,
  incomeOf,
  kindsOf,
  legsOfKind,
  modifierRevenueOf,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "./ledger-helpers.ts";

describeAccounting(() => {
  test("a real public paid order recognises income shown on the admin pages", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Workshop",
      unitPrice: 5000,
    });

    const attendeeId = await completePaidOrder(
      listing.id,
      "Customer",
      "customer@example.com",
      5000,
    );

    // Ledger truth: gross income recognised, buyer paid in full (owes nothing).
    expect(await incomeOf(listing.id)).toBe(5000);
    expect(await owedBy(attendeeId)).toBe(0);

    // The booking's legs are a sale + a payment under ONE event group (the
    // booking fee defaults to 0 in a fresh setup, so there is no fee leg).
    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(kindsOf(legs)).toEqual(["payment", "sale"]);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);
    expect(legsOfKind(legs, "sale")[0]!.amount).toBe(5000);
    expect(legsOfKind(legs, "payment")[0]!.amount).toBe(5000);
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);

    // Rendered admin value agrees on both the ledger statement and the edit page.
    await assertRenderedIncome(listing.id, 5000);
  });

  // 2. A deposit leaves the remainder owed (ledger + balance page), and settling
  //    through the production settle clears it to zero on both.
  test("a deposit owes the remainder until settled, on the ledger and balance page", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Retreat",
      unitPrice: 8000,
    });
    // Owe the full £80 with nothing paid, then post a £30 deposit payment, so
    // £50 remains. createTestAttendee on a provider-less priced listing already
    // posts the gross owed sale, so the deposit is the only extra leg needed.
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Deposit Payer",
      "deposit@example.com",
    );
    expect(await owedBy(attendee.id)).toBe(8000);
    await postListingSale({
      amountPaid: 3000,
      attendeeId: attendee.id,
      // gross 0 adds no new sale; only the £30 deposit payment leg is posted.
      gross: 0,
      listingId: listing.id,
    });

    // Ledger + admin ledger page agree: £50 outstanding.
    expect(await owedBy(attendee.id)).toBe(5000);
    await assertRenderedOwed(attendee.id, 5000);

    // Settle the remaining balance the production way and re-check both.
    const result = await settleAttendeeBalance(attendee.id, 5000, {
      id: "settle-e2e",
      occurredAt: "2026-06-22T00:00:00.000Z",
    });
    expect(result.settled).toBe(true);
    expect(await owedBy(attendee.id)).toBe(0);
    const settledPage = await adminPageHtml(
      `/admin/attendees/${attendee.id}/ledger`,
    );
    expect(settledPage).toContain("This booking is fully paid");
  });

  // 3. A manual income write-off (decision 14) lowers recognised income by
  //    exactly the delta, posts a single writeoff↔revenue adjustment, and leaves
  //    WORLD (the cash report) untouched. A later refund still behaves sanely.
  test("a manual income write-off lowers income without touching cash", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Gala",
      unitPrice: 5000,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Gala Guest",
      "gala@example.com",
      5000,
      "cs_gala",
      "pi_gala",
    );
    expect(await incomeOf(listing.id)).toBe(5000);
    const worldBefore = await worldBalance();
    const writeoffBefore = await accountBalance(WRITEOFF);

    // Write the recognised income down from £50 to £20 (income field is MAJOR).
    const response = (
      await adminFormPost(`/admin/listing/${listing.id}/income`, {
        income: "20.00",
      })
    ).response;
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income corrected.",
    )(response);

    // Income dropped by exactly £30; the correction is one writeoff↔revenue leg.
    expect(await incomeOf(listing.id)).toBe(2000);
    const revenueLegs = await transfersByAccount(revenueAccount(listing.id));
    const adjustments = legsOfKind(revenueLegs, "adjustment");
    expect(adjustments.length).toBe(1);
    expect(adjustments[0]!.amount).toBe(3000);
    // The write-down debits revenue toward the writeoff contra account.
    expect(adjustments[0]!.source).toEqual(revenueAccount(listing.id));
    expect(adjustments[0]!.destination).toEqual(WRITEOFF);
    // WORLD is untouched (cash report stays honest); writeoff absorbed the £30.
    expect(await worldBalance()).toBe(worldBefore);
    expect(await accountBalance(WRITEOFF)).toBe(writeoffBefore + 3000);

    // Rendered admin value reflects the corrected income on both surfaces.
    await assertRenderedIncome(listing.id, 2000);

    // A refund after a write-down still behaves sanely. The refund reverses only
    // the booking's OWN legs (the £50 sale + £50 payment), not the manual
    // write-off adjustment — so the buyer ends owing nothing and their cash
    // returns to the world, but the £30 write-off remains a standing debit on the
    // revenue account. The raw revenue balance is therefore £50 − £30 − £50 = −£30
    // (the ledger statement shows this), while the edit page (gross-minus-write-
    // offs, refund-agnostic) still shows £50 − £30 = £20. Conservation still holds.
    await withRefundMock(true, async (mockRefund) => {
      const refund = await submitRefund(attendeeId, "Gala Guest");
      expectRedirect(refund, /\/admin\/attendees\/\d+\/actions/);
      expect(mockRefund.calls.length).toBe(1);
    });
    expect(await owedBy(attendeeId)).toBe(0);
    expect(await incomeOf(listing.id)).toBe(-3000);
    expect(await sumOfAllBalances()).toBe(0);
    const refundCash = legsOfKind(
      await transfersByAccount(attendeeAccount(attendeeId)),
      "refund_cash",
    );
    expect(refundCash.length).toBe(1);
    expect(refundCash[0]!.amount).toBe(5000);
    // Both rendered income surfaces, each against its own (divergent) contract.
    await assertStatementBalance(listing.id, -3000);
    await assertEditPageIncome(listing.id, 2000);
  });

  // 4. A manual attendee-balance correction moves what's owed up and then down
  //    by exactly the delta on both the ledger and the balance page, and never
  //    moves WORLD.
  test("a manual attendee-balance correction moves owed up and down, cash untouched", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Series Pass",
      unitPrice: 6000,
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Balance Edith",
      "edith@example.com",
    );
    // Provider-less priced booking starts owing the full £60.
    expect(await owedBy(attendee.id)).toBe(6000);
    const worldStart = await worldBalance();

    // Correct owed DOWN by £35 through the ledger (goodwill write-off): £60 → £25.
    const down = await postAttendeeBalanceEntry(
      attendee.id,
      MANUAL_ATTENDEE_WRITEOFF,
      "35.00",
    );
    expect(down.status).toBe(302);
    expect(await owedBy(attendee.id)).toBe(2500);
    await assertRenderedOwed(attendee.id, 2500);
    expect(await worldBalance()).toBe(worldStart);

    // Correct owed UP by £15 (a manual charge): £25 → £40.
    const up = await postAttendeeBalanceEntry(
      attendee.id,
      MANUAL_ATTENDEE_CHARGE,
      "15.00",
    );
    expect(up.status).toBe(302);
    expect(await owedBy(attendee.id)).toBe(4000);
    await assertRenderedOwed(attendee.id, 4000);
    // Cash never moved through either correction — only the writeoff contra did.
    expect(await worldBalance()).toBe(worldStart);
    // The recognised sale income is unchanged; corrections touch only the
    // attendee's clearing account against writeoff.
    expect(await incomeOf(listing.id)).toBe(6000);
  });

  // 5. A manual modifier-revenue correction moves a seeded modifier's revenue to
  //    the target on the ledger and on the modifier edit/list pages.
  test("a manual modifier-revenue correction moves revenue to the target", async () => {
    const modifier = await insertModifier({
      calcValue: 700,
      name: "VIP Surcharge",
    });
    // Seed a real surcharge leg: +£7 collected.
    await postModifierLeg({ delta: 700, modifierId: modifier.id });
    expect(await modifierRevenueOf(modifier.id)).toBe(700);
    const worldBefore = await worldBalance();

    // Correct the net revenue to £12 (total_revenue field is MAJOR units).
    const response = (
      await adminFormPost(`/admin/modifiers/${modifier.id}/revenue`, {
        total_revenue: "12.00",
      })
    ).response;
    await expectFlashRedirect(
      `/admin/modifiers/${modifier.id}/edit`,
      "Option income corrected.",
    )(response);

    // Ledger moved to exactly the target via a single writeoff↔modifier leg.
    expect(await modifierRevenueOf(modifier.id)).toBe(1200);
    const adjustments = legsOfKind(
      await transfersByAccount(modifierAccount(modifier.id)),
      "adjustment",
    );
    expect(adjustments.length).toBe(1);
    expect(adjustments[0]!.amount).toBe(500);
    // Raising revenue credits the modifier from writeoff.
    expect(adjustments[0]!.source).toEqual(WRITEOFF);
    expect(adjustments[0]!.destination).toEqual(modifierAccount(modifier.id));
    expect(await worldBalance()).toBe(worldBefore);

    // Rendered admin value agrees on the edit page and the list.
    await assertRenderedModifierRevenue(modifier.id, 1200);
  });
});
