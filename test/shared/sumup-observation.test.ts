import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderInvalidReason } from "#payment/provider-read.ts";
import {
  classifySumupCheckout,
  type SumupReadFacts,
} from "#shared/sumup-observation.ts";

/**
 * Wire shapes follow the sandbox evidence recorded in PR3_PLAN.md ("SumUp
 * sandbox evidence result", collected 2026-08-05): pending carries an empty
 * transactions array and no transaction_id; paid names its transaction and
 * carries exactly one matching successful entry; failed carries exactly one
 * failed entry and no transaction_id.
 */
const FACTS: SumupReadFacts = {
  merchantCode: "MC123",
  requestedId: "co_1",
  siteCurrency: "GBP",
};

const WIRE_TXN = {
  amount: 10,
  currency: "GBP",
  id: "txn",
  merchant_code: "MC123",
  status: "SUCCESSFUL",
};

const wirePaid = (over: Record<string, unknown> = {}) => ({
  amount: 10,
  checkout_reference: "ref",
  currency: "GBP",
  date: "2026-08-05T12:00:00.000Z",
  id: "co_1",
  merchant_code: "MC123",
  status: "PAID",
  transaction_id: "txn",
  transactions: [WIRE_TXN],
  ...over,
});

const wirePending = (over: Record<string, unknown> = {}) => {
  const { transaction_id: _, ...paidWithoutTxnId } = wirePaid({
    status: "PENDING",
    transactions: [],
    ...over,
  });
  return paidWithoutTxnId;
};

const classify = (body: unknown) => classifySumupCheckout(body, FACTS);

describe("classifySumupCheckout", () => {
  test("reads a paid checkout into the normalized shape", () => {
    expect(classify(wirePaid())).toEqual({
      resource: {
        amountMinor: 1000,
        createdAt: "2026-08-05T12:00:00.000Z",
        currency: "GBP",
        reference: "ref",
        status: "PAID",
        transactionId: "txn",
      },
      status: "found",
    });
  });

  test("reads a pending checkout with no attempts yet", () => {
    const read = classify(wirePending());
    expect(read).toEqual({
      resource: expect.objectContaining({
        status: "PENDING",
        transactionId: "",
      }),
      status: "found",
    });
  });

  test("allows failed attempts under a pending checkout", () => {
    const failedAttempt = { ...WIRE_TXN, id: "txn_old", status: "FAILED" };
    const read = classify(wirePending({ transactions: [failedAttempt] }));
    expect(read).toEqual(expect.objectContaining({ status: "found" }));
  });

  test("allows a charge landing under its own still-open checkout", () => {
    // The one unrecorded child the boundary accepts: a charge under the same
    // pending checkout — the next fetch will read the checkout as paid.
    const read = classify(wirePending({ transactions: [WIRE_TXN] }));
    expect(read).toEqual(expect.objectContaining({ status: "found" }));
  });

  test("reads a failed checkout with its failed attempt", () => {
    const failedTxn = { ...WIRE_TXN, status: "FAILED" };
    const read = classify(
      wirePending({ status: "FAILED", transactions: [failedTxn] }),
    );
    expect(read).toEqual({
      resource: expect.objectContaining({ status: "FAILED" }),
      status: "found",
    });
  });

  test("reads an expired checkout like a failed one", () => {
    const read = classify(wirePending({ status: "EXPIRED" }));
    expect(read).toEqual({
      resource: expect.objectContaining({ status: "EXPIRED" }),
      status: "found",
    });
  });

  test("carries unreadable money through for the boundary to refuse", () => {
    // Ownership is proven (id, merchant, named child agree), so malformed
    // money must not refuse the read: the session boundary turns it into a
    // refundable rejection, which is what returns the buyer's captured money.
    const txn = { ...WIRE_TXN, currency: "GB" };
    const read = classify(wirePaid({ currency: "GB", transactions: [txn] }));
    expect(read).toEqual({
      resource: expect.objectContaining({ amountMinor: 1000, currency: "GB" }),
      status: "found",
    });
  });

  test("carries an amount finer than the currency through as unreadable", () => {
    const txn = { ...WIRE_TXN, amount: 10.001 };
    const read = classify(wirePaid({ amount: 10.001, transactions: [txn] }));
    expect(read).toEqual({
      resource: expect.objectContaining({ amountMinor: null }),
      status: "found",
    });
  });

  test("reads precision by the checkout's own currency", () => {
    // 12.5 yen is finer than yen can hold, even though the site's GBP could
    // hold it: the charge's own currency decides its decimal places.
    const txn = { ...WIRE_TXN, amount: 12.5, currency: "JPY" };
    const read = classify(
      wirePaid({ amount: 12.5, currency: "JPY", transactions: [txn] }),
    );
    expect(read).toEqual({
      resource: expect.objectContaining({ amountMinor: null, currency: "JPY" }),
      status: "found",
    });
  });

  test("reads amounts with the site currency given a blank currency", () => {
    // A blank code never reaches the conversion helpers (Intl throws on
    // one): the amount converts with the site's currency, and the carried
    // null code is for the boundary to refuse.
    const txn = { ...WIRE_TXN, currency: "   " };
    const read = classify(wirePaid({ currency: "   ", transactions: [txn] }));
    expect(read).toEqual({
      resource: expect.objectContaining({ amountMinor: 1000, currency: null }),
      status: "found",
    });
  });

  test("reads a paid checkout that carries no amount", () => {
    // Nothing to convert or precision-check; the null reaches the session
    // boundary, whose refusal is what sends the charge to the refund path.
    const txn = { ...WIRE_TXN, amount: undefined };
    const read = classify(wirePaid({ amount: undefined, transactions: [txn] }));
    expect(read).toEqual({
      resource: expect.objectContaining({ amountMinor: null }),
      status: "found",
    });
  });

  const invalid = (reason: ProviderInvalidReason) => ({
    reason,
    status: "invalid",
  });

  test("refuses a body that is not a checkout at all", () => {
    expect(classify("nonsense")).toEqual(invalid("malformed_response"));
  });

  test("refuses a checkout with no usable reference", () => {
    expect(classify(wirePaid({ checkout_reference: " " }))).toEqual(
      invalid("malformed_response"),
    );
    const { checkout_reference: _, ...withoutReference } = wirePaid();
    expect(classify(withoutReference)).toEqual(invalid("malformed_response"));
  });

  test("refuses a checkout answering for a different id", () => {
    expect(classify(wirePaid({ id: "co_other" }))).toEqual(
      invalid("mismatched_id"),
    );
  });

  test("refuses a checkout under another merchant", () => {
    expect(classify(wirePaid({ merchant_code: "MC999" }))).toEqual(
      invalid("mismatched_account"),
    );
  });

  test("refuses a status outside the documented lifecycle", () => {
    expect(classify(wirePaid({ status: "REFUNDED" }))).toEqual(
      invalid("unsupported_status"),
    );
    const { status: _, ...withoutStatus } = wirePaid();
    expect(classify(withoutStatus)).toEqual(invalid("unsupported_status"));
  });

  test("refuses a paid checkout that names no transaction", () => {
    const { transaction_id: _, ...unnamed } = wirePaid();
    expect(classify(unnamed)).toEqual(invalid("missing_documented_resource"));
  });

  test("refuses a paid checkout whose named transaction is absent", () => {
    expect(classify(wirePaid({ transactions: [] }))).toEqual(
      invalid("missing_documented_resource"),
    );
  });

  test("refuses a second captured charge on a paid checkout", () => {
    const second = { ...WIRE_TXN, id: "txn_2" };
    expect(classify(wirePaid({ transactions: [WIRE_TXN, second] }))).toEqual(
      invalid("unrecorded_child"),
    );
  });

  test("refuses a successful charge that is not the named one", () => {
    const other = { ...WIRE_TXN, id: "txn_other" };
    expect(classify(wirePaid({ transactions: [other] }))).toEqual(
      invalid("unrecorded_child"),
    );
  });

  test("refuses a charge captured under another merchant", () => {
    const foreign = { ...WIRE_TXN, merchant_code: "MC999" };
    expect(classify(wirePaid({ transactions: [foreign] }))).toEqual(
      invalid("unrecorded_child"),
    );
  });

  // The named charge must vouch for the money a booking would be priced by:
  // when it disputes the checkout's record, or omits the fields the paid
  // shape documents, the money is carried as unreadable — ownership stands
  // (id and merchant agree), so the refund path returns it rather than a
  // refusal stranding it.
  for (const [name, txnOverrides] of [
    ["disputes the checkout's amount", { amount: 12 }],
    ["disputes the checkout's currency", { currency: "EUR" }],
    ["states no amount", { amount: undefined }],
    ["states no currency", { currency: undefined }],
  ] as const) {
    test(`carries money to the refund path when the charge ${name}`, () => {
      const txn = { ...WIRE_TXN, ...txnOverrides };
      expect(classify(wirePaid({ transactions: [txn] }))).toEqual({
        resource: expect.objectContaining({ amountMinor: null }),
        status: "found",
      });
    });
  }

  // The clauses above forgive a checkout that states less than its charge
  // does, rather than reading silence as a dispute. Only the checkout's own
  // record prices the booking, so what each absence costs differs.
  test("reads the money when only the charge names the currency", () => {
    const { currency: _, ...noCurrency } = wirePaid();
    expect(classify(noCurrency)).toEqual({
      resource: expect.objectContaining({
        // Read in the site currency, because the checkout named none, and
        // carried as null so the boundary can see that it named none.
        amountMinor: 1000,
        currency: null,
      }),
      status: "found",
    });
  });

  test("cannot read the money when only the charge names the amount", () => {
    const { amount: _, ...noAmount } = wirePaid();
    expect(classify(noAmount)).toEqual({
      // The charge vouches for the checkout, but a booking is priced by the
      // checkout's own amount, and this one states none.
      resource: expect.objectContaining({ amountMinor: null }),
      status: "found",
    });
  });

  test("refuses a second successful charge on a pending checkout", () => {
    const second = { ...WIRE_TXN, id: "txn_2" };
    const read = classify(wirePending({ transactions: [WIRE_TXN, second] }));
    expect(read).toEqual(invalid("unrecorded_child"));
  });

  test("refuses a pending charge captured under another merchant", () => {
    // The pending allowance covers a charge under this checkout — a charge
    // under someone else's merchant is not that.
    const foreign = { ...WIRE_TXN, merchant_code: "MC999" };
    const read = classify(wirePending({ transactions: [foreign] }));
    expect(read).toEqual(invalid("unrecorded_child"));
  });

  test("refuses captured money on a failed checkout", () => {
    // Decided behavior: a dead checkout showing captured money stops
    // automatic work — never booked, never silently acknowledged.
    const read = classify(
      wirePending({ status: "FAILED", transactions: [WIRE_TXN] }),
    );
    expect(read).toEqual(invalid("unrecorded_child"));
  });

  test("refuses captured money on an expired checkout", () => {
    const read = classify(
      wirePending({ status: "EXPIRED", transactions: [WIRE_TXN] }),
    );
    expect(read).toEqual(invalid("unrecorded_child"));
  });
});
