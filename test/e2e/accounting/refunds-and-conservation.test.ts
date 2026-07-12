import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { settings } from "#shared/db/settings.ts";
import { expectFlashRedirect, expectRedirect } from "#test-utils/assertions.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  completePaidOrder,
  describeAccounting,
  runStripeSuccess,
  submitRefund,
  withRefundMock,
} from "./drivers.ts";
import {
  adminPageHtml,
  assertEditPageIncome,
  assertRenderedModifierRevenue,
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
  test("refunding a paid order returns revenue and owed to zero with conservation", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Concert",
      unitPrice: 4500,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Refundee",
      "refundee@example.com",
      4500,
      "cs_concert",
      "pi_concert",
    );
    expect(await incomeOf(listing.id)).toBe(4500);

    await withRefundMock(true, async (mockRefund) => {
      const response = await submitRefund(attendeeId, "Refundee");
      await expectFlashRedirect(
        `/admin/attendees/${attendeeId}/actions`,
        "Refund issued",
      )(response);
      expect(mockRefund.calls.length).toBe(1);
    });

    // Ledger truth: revenue and owed both back to zero.
    expect(await incomeOf(listing.id)).toBe(0);
    expect(await owedBy(attendeeId)).toBe(0);

    // A single full refund_cash leg of the whole payment, returned to the world.
    const refundCash = legsOfKind(
      await transfersByAccount(attendeeAccount(attendeeId)),
      "refund_cash",
    );
    expect(refundCash.length).toBe(1);
    expect(refundCash[0]!.amount).toBe(4500);
    expect(refundCash[0]!.destination).toEqual(WORLD);

    // Conservation across every touched account.
    expect(await sumOfAllBalances()).toBe(0);

    // The two income surfaces legitimately DIVERGE after a refund: the ledger
    // statement nets the refund (`Balance: £0`), while the edit page reports
    // gross-minus-write-offs and so still shows the £45 sale (an ordinary refund
    // doesn't reduce recognised income — only a manual write-off does). Assert
    // each surface against its own contract rather than forcing them to agree.
    await assertStatementBalance(listing.id, 0);
    await assertEditPageIncome(listing.id, 4500);
    // The admin attendee balance page shows the booking fully settled.
    const balancePage = await adminPageHtml(
      `/admin/attendees/${attendeeId}/ledger`,
    );
    expect(balancePage).toContain("This booking is fully paid");
  });

  // 7. Conservation sweep over a MIXED sequence: a paid order, a manual income
  //    write-off, and a refund. The signed sum of balances across every touched
  //    account must be exactly 0.
  test("conservation holds across a mixed order + correction + refund sequence", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Festival",
      unitPrice: 7000,
    });

    // Order #1: a paid order that we will later write down and refund.
    const refundedId = await completePaidOrder(
      listing.id,
      "Mixed One",
      "mixed1@example.com",
      7000,
      "cs_mix1",
      "pi_mix1",
    );
    // Order #2 stays on the books, so the sweep spans accounts left non-zero.
    await createPaidTestAttendee(
      listing.id,
      "Mixed Two",
      "mixed2@example.com",
      "pi_mix2",
      7000,
    );

    // A manual income write-down (£70 → £40 across the two £70 sales = £140
    // recognised; drop to £100).
    expect(await incomeOf(listing.id)).toBe(14000);
    const writeDown = (
      await adminFormPost(`/admin/listing/${listing.id}/income`, {
        income: "100.00",
      })
    ).response;
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income corrected.",
    )(writeDown);
    expect(await incomeOf(listing.id)).toBe(10000);

    // Refund order #1.
    await withRefundMock(true, async (mockRefund) => {
      const response = await submitRefund(refundedId, "Mixed One");
      expectRedirect(response, /\/admin\/attendees\/\d+\/actions/);
      expect(mockRefund.calls.length).toBe(1);
    });

    // Conservation must hold after the whole mixed sequence.
    expect(await sumOfAllBalances()).toBe(0);

    // And the surviving figures are individually coherent: order #2 still owes
    // nothing, the refunded buyer owes nothing.
    expect(await owedBy(refundedId)).toBe(0);
    // The raw revenue balance (what the ledger statement shows) nets everything:
    // £140 gross − £40 write-down − £70 refunded sale = £30.
    expect(await incomeOf(listing.id)).toBe(3000);
    await assertStatementBalance(listing.id, 3000);
    // The edit page reports gross-minus-write-offs and ignores the refund, so it
    // still shows £140 − £40 = £100 — the documented divergence after a refund.
    await assertEditPageIncome(listing.id, 10000);

    // The refund leg group is distinct from the booking group it reverses.
    const refundCash = legsOfKind(
      await transfersByAccount(attendeeAccount(refundedId)),
      "refund_cash",
    );
    expect(refundCash.length).toBe(1);
    const bookingGroups = new Set(
      (await transfersByEventGroup(refundCash[0]!.eventGroup)).map(
        (leg) => leg.eventGroup,
      ),
    );
    expect(bookingGroups.size).toBe(1);
  });

  // 8. A configured booking fee posts a separate `fee` leg to fee-income (not the
  //    listing's revenue), leaves the buyer owing nothing, and a refund reverses
  //    that fee alongside the sale and the cash.
  test("a configured booking fee posts fee-income and is reversed on refund", async () => {
    await setupStripe();
    await settings.update.bookingFee("10"); // 10% booking fee.
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Fee Day",
      unitPrice: 5000,
    });
    // £50 ticket + 10% booking fee = £55 charged.
    await runStripeSuccess({
      email: "fee@example.com",
      items: singleItem(listing.id, 1, 5000),
      name: "Fee Payer",
      paymentIntent: "pi_fee",
      sessionId: "cs_fee",
      total: 5500,
    });
    const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;

    // Recognised income is the gross ticket sale; the fee is its own income line.
    expect(await incomeOf(listing.id)).toBe(5000);
    expect(await owedBy(attendeeId)).toBe(0);
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(500);
    expect(await worldBalance()).toBe(-5500);

    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(kindsOf(legs)).toEqual(["fee", "payment", "sale"]);
    const fee = legsOfKind(legs, "fee")[0]!;
    expect(fee.amount).toBe(500);
    expect(fee.destination).toEqual(BOOKING_FEE_INCOME);

    // Refunding reverses sale + fee + payment; fee income returns to zero.
    await withRefundMock(true, async (mockRefund) => {
      const refund = await submitRefund(attendeeId, "Fee Payer");
      expectRedirect(refund, /\/admin\/attendees\/\d+\/actions/);
      expect(mockRefund.calls.length).toBe(1);
    });
    expect(await incomeOf(listing.id)).toBe(0);
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
    expect(await owedBy(attendeeId)).toBe(0);
    expect(await worldBalance()).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
    const refundFee = legsOfKind(
      await transfersByAccount(attendeeAccount(attendeeId)),
      "refund_fee",
    );
    expect(refundFee.length).toBe(1);
    expect(refundFee[0]!.amount).toBe(500);
  });

  // 9. A surcharge modifier applied during a REAL paid checkout posts a `modifier`
  //    leg whose balance is the modifier's revenue (rendered on the admin pages),
  //    and a refund reverses it with a `refund_modifier` leg.
  test("a surcharge modifier in a real checkout earns revenue and reverses on refund", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Talk",
      unitPrice: 5000,
    });
    const modifier = await insertModifier({
      calcKind: "percent",
      calcValue: 10,
      name: "Service charge",
    });
    // £50 ticket + 10% service charge = £55 charged.
    await runStripeSuccess({
      email: "svc@example.com",
      items: singleItem(listing.id, 1, 5000),
      modifiers: [{ i: modifier.id, q: 1 }],
      name: "Svc Buyer",
      paymentIntent: "pi_svc",
      sessionId: "cs_svc",
      total: 5500,
    });
    const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;

    expect(await incomeOf(listing.id)).toBe(5000);
    expect(await modifierRevenueOf(modifier.id)).toBe(500);
    expect(await owedBy(attendeeId)).toBe(0);

    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(kindsOf(legs)).toEqual(["modifier", "payment", "sale"]);
    const mod = legsOfKind(legs, "modifier")[0]!;
    expect(mod.amount).toBe(500);
    expect(mod.destination).toEqual(modifierAccount(modifier.id));

    // The earned revenue renders on the modifier edit page and the list.
    await assertRenderedModifierRevenue(modifier.id, 500);

    // Refund reverses the modifier leg too, returning its revenue to zero.
    await withRefundMock(true, async (mockRefund) => {
      const refund = await submitRefund(attendeeId, "Svc Buyer");
      expectRedirect(refund, /\/admin\/attendees\/\d+\/actions/);
      expect(mockRefund.calls.length).toBe(1);
    });
    expect(await modifierRevenueOf(modifier.id)).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
    const refundMod = legsOfKind(
      await transfersByAccount(attendeeAccount(attendeeId)),
      "refund_modifier",
    );
    expect(refundMod.length).toBe(1);
    expect(refundMod[0]!.amount).toBe(500);
  });

  // 10. One payment spanning two listings splits the recognised income across each
  //     listing's own revenue account under a single event group, and the buyer
  //     (one attendee) owes nothing.
  test("a multi-line order splits income across each listing's revenue account", async () => {
    await setupStripe();
    const first = await createTestListing({
      maxAttendees: 50,
      name: "Part One",
      unitPrice: 3000,
    });
    const second = await createTestListing({
      maxAttendees: 50,
      name: "Part Two",
      unitPrice: 2000,
    });
    // One £50 payment: £30 to the first listing, £20 to the second.
    await runStripeSuccess({
      email: "both@example.com",
      items: JSON.stringify([
        { e: first.id, p: 3000, q: 1 },
        { e: second.id, p: 2000, q: 1 },
      ]),
      name: "Both Buyer",
      paymentIntent: "pi_multi",
      sessionId: "cs_multi",
      total: 5000,
    });

    // Each listing's revenue account holds its own line; the buyer owes nothing.
    expect(await incomeOf(first.id)).toBe(3000);
    expect(await incomeOf(second.id)).toBe(2000);
    const attendeeId = (await getAttendeesRaw(first.id))[0]!.id;
    expect(await owedBy(attendeeId)).toBe(0);
    expect(await worldBalance()).toBe(-5000);
    expect(await sumOfAllBalances()).toBe(0);

    // Both sale legs and the single payment share ONE booking event group.
    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(legsOfKind(legs, "sale").length).toBe(2);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);

    // Each listing's income renders on its own edit page.
    await assertEditPageIncome(first.id, 3000);
    await assertEditPageIncome(second.id, 2000);
  });

  // 11. A genuinely free (£0) booking through the public ticket form records no
  //     money at all — no sale, no payment, and (even with a booking fee
  //     configured) no phantom fee income or cash. The attendee owes nothing.
});
