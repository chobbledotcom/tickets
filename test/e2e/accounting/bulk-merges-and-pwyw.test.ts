import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WRITEOFF } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { expectFlash, expectFlashRedirect } from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
  describeAccounting,
  mergePost,
  mergePreview,
  moneyFieldFor,
  runStripeSuccess,
  twoPaidDuplicates,
  withRefundMock,
} from "#test-utils/money/drivers.ts";
import {
  adminPageHtml,
  assertRenderedIncome,
  attendeeLegsOfKind,
  incomeOf,
  norm,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test-utils/money/reads.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Post a keep-target merge that discards the source duplicate under one money
 *  decision (credit the over-payment back, or write it off). */
const keepTargetMerge = (
  targetId: number,
  {
    bookingField,
    version,
    sourceToken,
    money,
  }: {
    bookingField: string;
    version: string;
    sourceToken: string;
    money: string;
  },
): Promise<Response> =>
  mergePost(targetId, {
    [bookingField]: "keep_target",
    [moneyFieldFor(bookingField)]: money,
    merge_version: version,
    source_token: sourceToken,
  });

describeAccounting(() => {
  test("a bulk refund continues past a failure and reverses only the successes", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Tour",
      unitPrice: 5000,
    });
    const one = await createPaidTestAttendee(
      listing.id,
      "One",
      "one@example.com",
      "pi_b1",
      5000,
    );
    const two = await createPaidTestAttendee(
      listing.id,
      "Two",
      "two@example.com",
      "pi_b2",
      5000,
    );
    const three = await createPaidTestAttendee(
      listing.id,
      "Three",
      "three@example.com",
      "pi_b3",
      5000,
    );
    expect(await incomeOf(listing.id)).toBe(15000);

    // The provider declines the middle payment only.
    await withRefundMock(
      (paymentId: string) => Promise.resolve(paymentId !== "pi_b2"),
      async (mockRefund) => {
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/refund-all`,
          { confirm_identifier: listing.name },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          "2 refunds succeeded. There was 1 failure. Some payments may have already been refunded.",
          false,
        )(response);
        expect(mockRefund.calls.length).toBe(3); // all three attempted
      },
    );

    // The two successes were reversed; the declined one keeps its sale and cash.
    const refundCashCount = async (id: number): Promise<number> =>
      (await attendeeLegsOfKind(id, "refund_cash")).length;
    expect(await refundCashCount(one.id)).toBe(1);
    expect(await refundCashCount(three.id)).toBe(1);
    expect(await refundCashCount(two.id)).toBe(0);
    // Income reflects exactly the one surviving sale; conservation still holds.
    expect(await incomeOf(listing.id)).toBe(5000);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 17. Merging two PAID duplicate bookings, CREDIT choice (decision 17 — an
  //     explicit operator choice, never a silent default): the survivor keeps ONE
  //     ticket, the discarded duplicate's recognised sale is un-billed (so the
  //     listing's income counts the kept ticket once, not twice), and the £50 the
  //     duplicate paid is handed back as the survivor's CREDIT. The source account
  //     empties, conservation holds, and the credit is shown on the balance page.
  test("a merge crediting a paid duplicate shows the survivor's credit", async () => {
    const { listingId, targetId, sourceId, sourceToken } =
      await twoPaidDuplicates("Reunion");
    // Both tickets recognised: income counts £100 before the merge resolves it.
    expect(await incomeOf(listingId)).toBe(10000);
    expect(await owedBy(targetId)).toBe(0);
    expect(await owedBy(sourceId)).toBe(0);

    // Keep the target ticket; CREDIT the discarded source payment (both decisions
    // are scraped from the rendered form, then applied).
    const { version, bookingField } = await mergePreview(targetId, sourceToken);
    const merged = await keepTargetMerge(targetId, {
      bookingField,
      money: "credit",
      sourceToken,
      version,
    });
    expect(merged.status).toBe(302);

    // Income now counts the ONE kept ticket; the survivor holds the over-paid £50
    // as a credit (negative owed); the source account is emptied; conservation holds.
    expect(await incomeOf(listingId)).toBe(5000);
    expect(await owedBy(targetId)).toBe(-5000);
    expect(norm(await accountBalance(attendeeAccount(sourceId)))).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);

    // Transparency: the survivor's ledger page renders the £50 credit figure.
    const balancePage = await adminPageHtml(
      `/admin/attendees/${targetId}/ledger`,
    );
    expect(balancePage).toContain(formatCurrency(-5000));
  });

  // 18. The same paid duplicate, WRITE-OFF choice: income still counts the one kept
  //     ticket, but the over-paid £50 is parked in the `writeoff` contra account
  //     rather than credited — the survivor owes nothing and cash reports stay
  //     honest. Conservation still holds.
  test("a merge writing off a paid duplicate parks the cash in writeoff", async () => {
    const { listingId, targetId, sourceId, sourceToken } =
      await twoPaidDuplicates("Gala");
    const writeoffBefore = norm(await accountBalance(WRITEOFF));

    const { version, bookingField } = await mergePreview(targetId, sourceToken);
    const merged = await keepTargetMerge(targetId, {
      bookingField,
      money: "writeoff",
      sourceToken,
      version,
    });
    expect(merged.status).toBe(302);

    // One ticket's income survives; the survivor owes nothing; the un-billed £50
    // lands in writeoff (not returned); the source empties; conservation holds.
    expect(await incomeOf(listingId)).toBe(5000);
    expect(await owedBy(targetId)).toBe(0);
    expect(norm(await accountBalance(WRITEOFF))).toBe(writeoffBefore + 5000);
    expect(norm(await accountBalance(attendeeAccount(sourceId)))).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 19. The decision-17 GUARD: a paid duplicate may NOT be discarded without an
  //     explicit money choice. Omitting it REFUSES the merge (the form re-renders
  //     with the error instead of redirecting) and mutates NOTHING — income still
  //     counts both tickets and the source still exists — so no silent double-count
  //     or stranded money can slip through.
  test("a merge refuses to discard a paid booking with no money decision", async () => {
    const { listingId, sourceToken, targetId } =
      await twoPaidDuplicates("Summit");

    const { version, bookingField } = await mergePreview(targetId, sourceToken);
    // Submit the booking choice but OMIT the money decision.
    const refused = await mergePost(targetId, {
      [bookingField]: "keep_target",
      merge_version: version,
      source_token: sourceToken,
    });
    // Bounced back to the Actions tab's merge panel with the validation
    // error flashed; the apply never ran.
    expect(refused.status).toBe(302);
    expectFlash(refused, expect.stringContaining("money decision"), false);

    // Nothing changed: both tickets' income still counts and both attendees survive.
    expect(await incomeOf(listingId)).toBe(10000);
    expect((await getAttendeesRaw(listingId)).length).toBe(2);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 20. A FREE duplicate (no money on either side) needs NO money decision: the
  //     preview surfaces the conflicting booking row but hides the credit/write-off
  //     UI, and the merge applies straight through posting no reversal legs — the
  //     "nothing at stake" path decision 17 must keep one-click.
  test("a free duplicate merges with no money decision and no reversal legs", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Freebie",
      unitPrice: 0,
    });
    const { attendee: target } = await createTestAttendeeDirect(
      listing.id,
      "Free A",
      "free-a@example.com",
    );
    const { token: sourceToken } = await createTestAttendeeDirect(
      listing.id,
      "Free B",
      "free-b@example.com",
    );
    // Nothing paid on either side — £0 at stake.
    expect(await incomeOf(listing.id)).toBe(0);

    // The preview shows the conflict row but NOT the money-decision UI.
    const preview = await adminGet(
      `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
        sourceToken,
      )}`,
    );
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('name="booking_');
    expect(previewHtml).not.toContain("merge-money-decision");
    expect(previewHtml).not.toContain("Discarded payment");

    const version = extractInputValue(previewHtml, "merge_version")!;
    const bookingField = previewHtml.match(/name="(booking_[^"]+)"/)![1]!;
    const merged = await mergePost(target.id, {
      [bookingField]: "keep_target",
      merge_version: version,
      source_token: sourceToken,
    });
    // No money decision required, so the merge redirects straight through.
    expect(merged.status).toBe(302);

    // The merge went through with no money moved and the source folded in.
    expect(await incomeOf(listing.id)).toBe(0);
    expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 21. A pay-what-you-want (can_pay_more) order recognises the FULL chosen price
  //     as income — the figure shown is exactly what the buyer paid, not the base
  //     price — and they owe nothing.
  test("a pay-what-you-want order recognises the chosen price as income", async () => {
    await setupStripe();
    const listing = await createTestListing({
      canPayMore: true,
      maxAttendees: 50,
      maxPrice: 10000,
      name: "Donate",
      unitPrice: 3000,
    });
    // Base £30, but the buyer chooses to pay £80 (within the £100 cap).
    await runStripeSuccess({
      email: "generous@example.com",
      items: singleItem(listing.id, 1, 8000),
      name: "Generous",
      paymentIntent: "pi_more",
      sessionId: "cs_more",
      total: 8000,
    });
    const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;

    expect(await incomeOf(listing.id)).toBe(8000);
    expect(await owedBy(attendeeId)).toBe(0);
    expect(await worldBalance()).toBe(-8000);
    // Both income surfaces render the chosen £80 (no refund has touched it).
    await assertRenderedIncome(listing.id, 8000);
  });
});
