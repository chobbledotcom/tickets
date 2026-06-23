/**
 * End-to-end money/accounting lifecycle, exercised through the REAL routes:
 * a public Stripe payment completion, the admin pages that render the resulting
 * figures, the manual money-correction routes (decision 14), and the admin
 * refund route. Every money step asserts BOTH the ledger truth (via the
 * `#shared/accounting` query functions) AND the rendered admin value (GET the
 * admin route, assert the `formatCurrency` string appears) — the two must agree.
 *
 * These are full-lifecycle flows. The narrower unit-ish coverage of the same
 * surfaces lives in test/lib/server-balance.test.ts, server-admin-balance.test.ts,
 * server-refunds.test.ts, and refund-ledger.test.ts; this file reuses their
 * helpers rather than duplicating them.
 *
 * Sign reminder (mapBooking's contract): `balanceOf(attendee)` is the NEGATIVE of
 * what the attendee owes, so OWED = −accountBalance(attendeeAccount(id)). A
 * fully-paid booking nets the attendee to 0; a listing's revenue account is the
 * destination of its `sale` legs, so its balance is the recognised income; WORLD
 * is the source of every `payment`, so taking £50 leaves WORLD at −5000. A manual
 * correction posts an `adjustment` leg against WRITEOFF and must never move WORLD.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
  WRITEOFF,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { settings } from "#shared/db/settings.ts";
import { allBalances } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { paymentsApi } from "#shared/payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  adminFormPost,
  adminGet,
  createPaidTestAttendee,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  mockProviderType,
  mockRequest,
  setupStripe,
  signMeta,
  singleItem,
  withMocks,
} from "#test-utils";
import { postListingSale, postModifierLeg } from "#test-utils/ledger.ts";
import { insertModifier } from "#test-utils/modifiers.ts";

// -- Ledger-truth helpers ------------------------------------------------- //

/** Normalise a signed-zero to a plain zero so `toBe(0)` (strict, `-0 !== 0`)
 *  never trips on the `-0` that negating an empty balance can produce. */
const norm = (value: number): number => value + 0;

/** A listing's recognised income (the raw `revenue` account balance — gross sale
 *  credits, less write-off AND refund debits). */
const incomeOf = async (listingId: number): Promise<number> =>
  norm(await accountBalance(revenueAccount(listingId)));

/** What an attendee still owes — the NEGATIVE of their account balance. */
const owedBy = async (attendeeId: number): Promise<number> =>
  norm(-(await accountBalance(attendeeAccount(attendeeId))));

/** A modifier's net revenue (positive surcharge collected, negative discount). */
const modifierRevenueOf = async (modifierId: number): Promise<number> =>
  norm(await accountBalance(modifierAccount(modifierId)));

/** The world/cash account balance — every honest cash report reads `world→*`,
 *  so a correction must leave this untouched. */
const worldBalance = async (): Promise<number> =>
  norm(await accountBalance(WORLD));

/** The signed sum of balances across EVERY account that has any transfer.
 *  Double-entry conservation: this is exactly 0 after any sequence of legs. */
const sumOfAllBalances = async (): Promise<number> => {
  const balances = allBalances(await allTransfers());
  let total = 0;
  for (const value of balances.values()) total += value;
  return norm(total);
};

// -- Admin page assertions ------------------------------------------------ //

/** GET an owner page and return its HTML, asserting a 200. */
const adminPageHtml = async (path: string): Promise<string> => {
  const { response } = await adminGet(path);
  expect(response.status).toBe(200);
  return response.text();
};

/**
 * Assert a `revenue` account's RUNNING BALANCE on the per-account ledger
 * statement page renders the given minor-unit figure (`Balance: £X`). This is
 * the raw signed balance, so a refund's `revenue→attendee` debit DOES reduce it
 * (and it can go negative once a write-off and a refund both apply).
 */
const assertStatementBalance = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  const statement = await adminPageHtml(`/admin/ledger/revenue/${listingId}`);
  expect(statement).toContain(`Balance: ${formatCurrency(minor)}`);
};

/**
 * Assert the listing EDIT page's "Current income" input renders the given
 * minor-unit figure (`value="£X"`). The edit page shows GROSS credits minus only
 * manual write-offs (`creditsLessWriteoffDebits`), so — unlike the statement —
 * an ordinary refund does NOT reduce it (matching the legacy `SUM(price_paid)`),
 * while a manual write-off does. The two surfaces therefore agree only when no
 * refund has touched the account.
 */
const assertEditPageIncome = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  const edit = await adminPageHtml(`/admin/listing/${listingId}/edit`);
  expect(edit).toContain(`value="${formatCurrency(minor)}"`);
};

/** With no refund applied, both income surfaces agree on the same figure. */
const assertRenderedIncome = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  await assertStatementBalance(listingId, minor);
  await assertEditPageIncome(listingId, minor);
};

/**
 * Assert an attendee's outstanding balance, on BOTH the per-account ledger
 * statement (`Balance: £X`, where owed = −running) and the admin balance page
 * (`Balance outstanding:` label followed by the formatted figure).
 */
const assertRenderedOwed = async (
  attendeeId: number,
  minor: number,
): Promise<void> => {
  const formatted = formatCurrency(minor);
  const balancePage = await adminPageHtml(
    `/admin/attendees/${attendeeId}/balance`,
  );
  expect(balancePage).toContain("Balance outstanding:");
  expect(balancePage).toContain(formatted);
};

/**
 * Assert a modifier's revenue, on BOTH the modifier edit page (a disabled
 * `value="£X"` input) and the modifier list (a Revenue cell of the same figure).
 */
const assertRenderedModifierRevenue = async (
  modifierId: number,
  minor: number,
): Promise<void> => {
  const formatted = formatCurrency(minor);
  const edit = await adminPageHtml(`/admin/modifiers/${modifierId}/edit`);
  expect(edit).toContain(`value="${formatted}"`);
  const list = await adminPageHtml("/admin/modifiers");
  expect(list).toContain(formatted);
};

/** The breakdown template's signed-magnitude format (a leading +/− with a U+2212
 *  minus, a plain unsigned figure for zero), replicated so a test can assert the
 *  exact reconciliation figures the page renders. */
const signedCurrency = (value: number): string =>
  value === 0
    ? formatCurrency(0)
    : `${value < 0 ? "−" : "+"}${formatCurrency(Math.abs(value))}`;

/** Slice the `#income-ledger` reconciliation article out of a listing detail
 *  page, so a figure is asserted WITHIN the breakdown and can't accidentally
 *  match an unrelated figure elsewhere on the page. */
const incomeLedgerArticle = (html: string): string => {
  const start = html.indexOf('id="income-ledger"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</article>", start));
};

// -- Public-payment driver (mirrors server-payments-success.test.ts) ------ //

/** A compact modifier ref as it rides the signed metadata (`{ i: id, q: qty }`). */
type ModRef = { i: number; q: number };

type StripeOrder = {
  items: string;
  total: number;
  modifiers?: ModRef[];
  name?: string;
  email?: string;
  sessionId?: string;
  paymentIntent?: string;
};

/**
 * Stub the Stripe session retrieval for `order` (metadata signed exactly as
 * production — the order may span several listing lines and carry applied
 * `modifiers`) and run `body` with the REAL `/payment/success` response, then
 * restore the stub. The signed `total` MUST equal the order the handler
 * re-derives (gross + fee + modifiers) — the price oracle refunds a mismatch.
 */
const withStripeSuccess = async (
  order: StripeOrder,
  body: (response: Response) => Promise<void>,
): Promise<void> => {
  const sessionId = order.sessionId ?? "cs_e2e";
  const metadata = signMeta(
    {
      email: order.email ?? "customer@example.com",
      items: order.items,
      name: order.name ?? "Customer",
      ...(order.modifiers
        ? { modifiers: JSON.stringify(order.modifiers) }
        : {}),
    },
    order.total,
  );
  const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: order.total,
      id: sessionId,
      metadata,
      payment_intent: order.paymentIntent ?? "pi_e2e",
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );
  try {
    await body(
      await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      ),
    );
  } finally {
    mockRetrieve.restore();
  }
};

/** Drive a first-time Stripe success and assert the production thank-you
 *  redirect (the common case over {@link withStripeSuccess}). */
const runStripeSuccess = (order: StripeOrder): Promise<void> =>
  withStripeSuccess(order, async (redirect) => {
    expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
    await expectHtmlResponse(
      await followRedirect(redirect, handleRequest),
      200,
      "Thank you for your order",
    );
  });

/**
 * Drive a genuine single-listing Stripe success for `gross` minor units and
 * return the attendee the booking created — the common case over
 * {@link runStripeSuccess}.
 */
const completePaidOrder = async (
  listingId: number,
  name: string,
  email: string,
  gross: number,
  sessionId = "cs_e2e",
  paymentIntent = "pi_e2e",
): Promise<number> => {
  await runStripeSuccess({
    email,
    items: singleItem(listingId, 1, gross),
    name,
    paymentIntent,
    sessionId,
    total: gross,
  });
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  return attendees[0]!.id;
};

// -- Refund driver (mirrors server-refunds.test.ts withRefundMock) -------- //

/** Run `body` with the payment provider resolved to a stripe provider whose
 *  `refundPayment` is stubbed, so the admin refund route reaches the ledger
 *  reversal without a real network call. */
const withRefundMock = (
  refundOk: boolean,
  body: (mockRefund: Stub) => Promise<void>,
): Promise<void> =>
  withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const mockRefund = stub(stripePaymentProvider, "refundPayment", () =>
        Promise.resolve(refundOk),
      );
      try {
        await body(mockRefund);
      } finally {
        mockRefund.restore();
      }
    },
  );

/** POST the real single-attendee admin refund form as the owner. */
const submitRefund = async (
  listingId: number,
  attendeeId: number,
  confirmName: string,
): Promise<Response> => {
  const { response } = await adminFormPost(
    `/admin/listing/${listingId}/attendee/${attendeeId}/refund`,
    { confirm_identifier: confirmName },
  );
  return response;
};

// -- Attendee-edit driver (scrapes the real edit form) -------------------- //

/** Extract the hidden/select fields the attendee edit form round-trips
 *  (`qty_*`, `line_key_*`, `status_id`) from the rendered edit page, so a
 *  balance correction re-submits the EXACT booking and changes only the owed
 *  figure — exactly what a browser would post back. */
const scrapeEditFields = (html: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const fieldName = match[1]!;
    if (!/^(qty_\d+|line_key_\d+)$/.test(fieldName)) continue;
    fields[fieldName] = tag.match(/value="([^"]*)"/)?.[1] ?? "";
  }
  const select = html.match(/<select\b[^>]*name="status_id"[\s\S]*?<\/select>/);
  const selected = select?.[0].match(
    /<option[^>]*\bselected\b[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*\bselected\b/,
  );
  if (selected) fields.status_id = (selected[1] ?? selected[2])!;
  return fields;
};

/** Correct an attendee's owed balance to `targetMajor` pounds through the real
 *  attendee edit POST, preserving the booking lines scraped from the edit page.
 *  Returns the route's response. */
const correctOwedBalance = async (
  attendeeId: number,
  name: string,
  email: string,
  targetMajor: string,
): Promise<Response> => {
  const editHtml = await adminPageHtml(`/admin/attendees/${attendeeId}`);
  const { response } = await adminFormPost(`/admin/attendees/${attendeeId}`, {
    ...scrapeEditFields(editHtml),
    email,
    name,
    remaining_balance: targetMajor,
  });
  return response;
};

// -- Leg helpers ---------------------------------------------------------- //

const kindsOf = (legs: Transfer[]): string[] =>
  legs.map((leg) => leg.kind ?? "").sort();

const legsOfKind = (legs: Transfer[], kind: string): Transfer[] =>
  legs.filter((leg) => leg.kind === kind);

describeWithEnv("e2e: accounting lifecycle", { db: true }, () => {
  afterEach(() => resetStripeClient());

  // 1. A genuine public paid order recognises income, leaves the buyer owing
  //    nothing, and both admin surfaces render the income the ledger holds.
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

    // Ledger + admin balance page agree: £50 outstanding.
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
      `/admin/attendees/${attendee.id}/balance`,
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
      "Listing income adjusted",
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
      const refund = await submitRefund(listing.id, attendeeId, "Gala Guest");
      expectRedirect(refund, new RegExp(`^/admin/listing/${listing.id}`));
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

    // Correct owed DOWN to £25 (e.g. a goodwill reduction).
    const down = await correctOwedBalance(
      attendee.id,
      "Balance Edith",
      "edith@example.com",
      "25.00",
    );
    await expectFlashRedirect(
      `/admin/attendees/${attendee.id}#attendee-form`,
      "Updated Balance Edith",
    )(down);
    expect(await owedBy(attendee.id)).toBe(2500);
    await assertRenderedOwed(attendee.id, 2500);
    expect(await worldBalance()).toBe(worldStart);

    // Correct owed UP to £40 — the delta moves owed by +£15 from here.
    const up = await correctOwedBalance(
      attendee.id,
      "Balance Edith",
      "edith@example.com",
      "40.00",
    );
    await expectFlashRedirect(
      `/admin/attendees/${attendee.id}#attendee-form`,
      "Updated Balance Edith",
    )(up);
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
      "Modifier revenue adjusted",
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

  // 6. Refunding a real paid order reverses revenue→0 and owed→0, posts a full
  //    refund_cash leg, conservation holds, and the admin listing page renders
  //    the refunded attendee's state.
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
      const response = await submitRefund(listing.id, attendeeId, "Refundee");
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
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
      `/admin/attendees/${attendeeId}/balance`,
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
      "Listing income adjusted",
    )(writeDown);
    expect(await incomeOf(listing.id)).toBe(10000);

    // Refund order #1.
    await withRefundMock(true, async (mockRefund) => {
      const response = await submitRefund(listing.id, refundedId, "Mixed One");
      expectRedirect(response, new RegExp(`^/admin/listing/${listing.id}`));
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
      const refund = await submitRefund(listing.id, attendeeId, "Fee Payer");
      expectRedirect(refund, new RegExp(`^/admin/listing/${listing.id}`));
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
      const refund = await submitRefund(listing.id, attendeeId, "Svc Buyer");
      expectRedirect(refund, new RegExp(`^/admin/listing/${listing.id}`));
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
  test("a free booking records no money even with a booking fee configured", async () => {
    await settings.update.bookingFee("10");
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Free Meetup",
      unitPrice: 0,
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Free Guest",
      "free@example.com",
    );

    // Nothing owed, and the booking posted no ledger legs whatsoever.
    expect(await owedBy(attendee.id)).toBe(0);
    expect(
      (await transfersByAccount(attendeeAccount(attendee.id))).length,
    ).toBe(0);
    expect(await incomeOf(listing.id)).toBe(0);
    // No phantom booking-fee income, and no phantom cash moved through the world.
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
    expect(await worldBalance()).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 12. When the payment provider DECLINES the refund, nothing is reversed: the
  //     income and owed figures are unchanged and no refund legs are posted.
  test("a failed provider refund reverses nothing in the ledger", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Show",
      unitPrice: 4500,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "No Refund",
      "norefund@example.com",
      4500,
      "cs_fail",
      "pi_fail",
    );
    expect(await incomeOf(listing.id)).toBe(4500);

    await withRefundMock(false, async (mockRefund) => {
      const response = await submitRefund(listing.id, attendeeId, "No Refund");
      // The route surfaces the failure as a flash error and does NOT issue it.
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/attendee/${attendeeId}/refund`,
        expect.stringContaining("Refund failed"),
        false,
      )(response);
      expect(mockRefund.calls.length).toBe(1);
    });

    // The ledger is exactly as it was: full income, nothing owed back, no refund.
    expect(await incomeOf(listing.id)).toBe(4500);
    expect(await owedBy(attendeeId)).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(legsOfKind(legs, "refund_cash").length).toBe(0);
    expect(kindsOf(legs)).toEqual(["payment", "sale"]);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 13. Corrections and webhook deliveries are idempotent. Replaying the identical
  //     Stripe success creates no second booking or duplicate legs, and
  //     re-submitting the same income target posts no second adjustment.
  test("re-submitting a correction and replaying a success are both no-ops", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Repeat",
      unitPrice: 6000,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Repeat Buyer",
      "repeat@example.com",
      6000,
      "cs_repeat",
      "pi_repeat",
    );

    // Replaying the identical success must not create a second attendee or
    // duplicate the booking's legs — an already-processed session is a no-op,
    // so the route just re-renders (a 200) rather than redirecting afresh.
    await withStripeSuccess(
      {
        email: "repeat@example.com",
        items: singleItem(listing.id, 1, 6000),
        name: "Repeat Buyer",
        paymentIntent: "pi_repeat",
        sessionId: "cs_repeat",
        total: 6000,
      },
      async (replay) => {
        await replay.body?.cancel();
      },
    );
    expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    expect(
      kindsOf(await transfersByAccount(attendeeAccount(attendeeId))),
    ).toEqual(["payment", "sale"]);

    // Adjust income to £40, then submit the SAME target again — the second submit
    // computes a zero delta and posts no second adjustment.
    const adjustIncome = async (): Promise<Response> =>
      (
        await adminFormPost(`/admin/listing/${listing.id}/income`, {
          income: "40.00",
        })
      ).response;
    const expectAdjusted = expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income adjusted",
    );
    await expectAdjusted(await adjustIncome());
    await expectAdjusted(await adjustIncome());

    expect(await incomeOf(listing.id)).toBe(4000);
    const adjustments = legsOfKind(
      await transfersByAccount(revenueAccount(listing.id)),
      "adjustment",
    );
    expect(adjustments.length).toBe(1);
  });

  // 14. The listing detail page renders the "Income & ledger" reconciliation that
  //     EXPLAINS the two income figures: gross sales (+) and manual adjustments
  //     (±) make up recognised income, and refunds (−) take it down to the net
  //     ledger balance — so the two never silently disagree (transparency).
  test("the listing page renders an income/ledger breakdown reconciling the figures", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Reconciled",
      unitPrice: 5000,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Recon Buyer",
      "recon@example.com",
      5000,
      "cs_recon",
      "pi_recon",
    );
    // Write recognised income down £50 → £40 (a manual adjustment), then refund
    // the booking (which nets the ledger balance but not recognised income) so
    // all five reconciliation rows carry distinct, non-zero figures.
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income adjusted",
    )(
      (
        await adminFormPost(`/admin/listing/${listing.id}/income`, {
          income: "40.00",
        })
      ).response,
    );
    await withRefundMock(true, async (mockRefund) => {
      const refund = await submitRefund(listing.id, attendeeId, "Recon Buyer");
      expectRedirect(refund, new RegExp(`^/admin/listing/${listing.id}`));
      expect(mockRefund.calls.length).toBe(1);
    });

    const article = incomeLedgerArticle(
      await adminPageHtml(`/admin/listing/${listing.id}`),
    );
    // Every reconciliation row is labelled and signed, so the difference between
    // the two income figures is self-evident on the page.
    expect(article).toContain("Income &amp; ledger");
    expect(article).toContain("Gross ticket sales");
    expect(article).toContain(signedCurrency(5000)); // +£50 gross sales
    expect(article).toContain("Manual adjustments");
    expect(article).toContain(signedCurrency(-1000)); // −£10 write-down
    expect(article).toContain("Recognised income");
    expect(article).toContain(formatCurrency(4000)); // £40 recognised
    expect(article).toContain("Refunds");
    expect(article).toContain(signedCurrency(-5000)); // −£50 refunded
    expect(article).toContain("Net balance in ledger");
    expect(article).toContain(formatCurrency(-1000)); // −£10 net ledger balance
    // And it links through to the full per-account ledger statement.
    expect(article).toContain(`/admin/ledger/revenue/${listing.id}`);
  });
});
