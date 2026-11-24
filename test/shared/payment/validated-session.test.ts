import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  isSessionRejection,
  paidPaymentReferenceOf,
  paymentReferenceOf,
  validatedPaymentSession,
} from "#payment/validated-session.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  asSession,
  BLANK_SESSION_METADATA,
  wireMetadata,
} from "#test-utils/payment-session.ts";

/**
 * The provider boundary: every paid session the live callbacks read is built by
 * `validatedPaymentSession`, so this is the one place a malformed charge,
 * currency, or provider resource id is refused. A free session carries no
 * resource id, so a blank one is allowed only when no money was captured. A
 * paid charge the boundary cannot read is refused with a refundable rejection
 * carrying its reference, so the callback can refund it instead of stranding it.
 */

const meta = { items: "[]", name: "Alice" } as SessionMetadata;

/** What the boundary hands on for {@link meta}. A rejection carries this
 *  canonical shape, not the provider's wire record, because the price proof
 *  was signed over it. */
const unpackedMeta = {
  ...BLANK_SESSION_METADATA,
  items: "[]",
  name: "Alice",
};

const basePaid = {
  createdAt: undefined,
  id: "sess-1",
  metadata: meta,
  paymentReference: "pi_123",
  paymentStatus: "paid" as const,
  provider: "stripe" as const,
};

describe("validatedPaymentSession", () => {
  // A refusal is observable as both a rejected build AND a logged error — the
  // spy is what catches a removed logError call.
  const errorSpy = setupErrorSpy();

  it("recognises a session rejection and nothing else", () => {
    expect(
      isSessionRejection({
        metadata: meta,
        provider: "stripe",
        reason: "blank_reference",
        sessionId: "cs_blank",
      }),
    ).toBe(true);
    expect(
      isSessionRejection({ provider: "stripe", reason: "blank_reference" }),
    ).toBe(false);
    expect(
      isSessionRejection({
        provider: "stripe",
        reason: "blank_reference",
        sessionId: "",
      }),
    ).toBe(false);
    expect(isSessionRejection({ reason: "blank_reference" })).toBe(false);
    expect(isSessionRejection({ reason: "unknown" })).toBe(false);
    // A malformed_charge without its metadata is an invented partial shape.
    expect(
      isSessionRejection({
        paymentReference: "pi_1",
        reason: "malformed_charge",
        refundable: false,
      }),
    ).toBe(false);
    expect(
      isSessionRejection({
        metadata: meta,
        paymentReference: "pi_1",
        provider: "stripe",
        reason: "malformed_charge",
        refundable: true,
        sessionId: "cs_malformed",
      }),
    ).toBe(true);
    expect(isSessionRejection(null)).toBe(false);
    expect(isSessionRejection({ ok: true })).toBe(false);
    expect(isSessionRejection("skip")).toBe(false);
  });

  /** A valid rejection of each reason, then each one with a single field
   *  broken. Only the valid shapes count. */
  const BLANK = {
    metadata: meta,
    provider: "stripe",
    reason: "blank_reference",
    sessionId: "cs_blank",
  };
  const MALFORMED = {
    ...BLANK,
    paymentReference: "pi_1",
    reason: "malformed_charge",
    refundable: true,
  };
  const BROKEN: [string, Record<string, unknown>][] = [
    ["no metadata", { ...BLANK, metadata: undefined }],
    ["null metadata", { ...BLANK, metadata: null }],
    ["text metadata", { ...BLANK, metadata: "items" }],
    ["an unknown provider", { ...BLANK, provider: "paypal" }],
    ["a provider that is not text", { ...BLANK, provider: 1 }],
    ["a session id that is not text", { ...BLANK, sessionId: 5 }],
    ["a blank session id", { ...BLANK, sessionId: "" }],
    ["a reference that is not text", { ...MALFORMED, paymentReference: 1 }],
    [
      "a refundable flag that is not true or false",
      { ...MALFORMED, refundable: "yes" },
    ],
  ];

  it("refuses a rejection with one field broken", () => {
    expect([isSessionRejection(BLANK), isSessionRejection(MALFORMED)]).toEqual([
      true,
      true,
    ]);
    for (const [name, value] of BROKEN) {
      expect([name, isSessionRejection(value)]).toEqual([name, false]);
    }
  });

  const subscription = {
    amount: 1200,
    id: "sub_rejected",
    interval: "month" as const,
    listingId: 1,
    status: "trialing" as const,
  };

  it("keeps observed subscription facts and ownership metadata on malformed_charge", () => {
    const build = validatedPaymentSession({
      ...basePaid,
      amountTotal: null,
      createdAt: "2026-07-19T12:00:00.000Z",
      currency: "GBP",
      paymentReference: "pi_123",
      subscription,
    });
    expect(build).toEqual(
      expect.objectContaining({
        createdAt: "2026-07-19T12:00:00.000Z",
        metadata: unpackedMeta,
        reason: "malformed_charge",
        subscription,
      }),
    );
  });

  for (const amountTotal of [1000, null]) {
    it(`throws for a paid subscription session with no charge and amount ${amountTotal}`, () => {
      expect(() =>
        validatedPaymentSession({
          ...basePaid,
          amountTotal,
          currency: "GBP",
          paymentReference: "",
          subscription,
        }),
      ).toThrow("Paid subscription session sess-1 names no charge");
    });
  }

  for (const [currency, expected] of [
    ["gbp", "GBP"],
    ["USD", "USD"],
  ] as const) {
    it(`builds a valid paid session in ${currency}`, () => {
      const build = asSession(
        validatedPaymentSession({
          ...basePaid,
          amountTotal: 1000,
          currency,
        }),
      );
      expect(build).toMatchObject({
        amountTotal: 1000,
        currency: expected,
        id: "sess-1",
        paymentReference: "pi_123",
        provider: "stripe",
      });
      expect(paymentReferenceOf(build)).toEqual({
        kind: "tagged",
        provider: "stripe",
        reference: "pi_123",
      });
    });
  }

  /** A paid session with and without its optional facts: each fact that
   *  arrives is kept, and one that does not arrive is not a key. */
  const createdAt = "2026-07-19T12:00:00.000Z";
  const PAID_SESSION = {
    amountTotal: 1000,
    currency: "GBP",
    id: "sess-1",
    metadata: unpackedMeta,
    paymentReference: "pi_123",
    paymentStatus: "paid",
    provider: "stripe",
  };
  const OPTIONAL_FACTS = [
    ["no optional fact", {}],
    ["a creation time", { createdAt }],
    ["a subscription", { subscription }],
    ["a creation time and a subscription", { createdAt, subscription }],
  ] as const;

  for (const [name, facts] of OPTIONAL_FACTS) {
    it(`builds a paid session with ${name}`, () => {
      expect(
        validatedPaymentSession({
          ...basePaid,
          amountTotal: 1000,
          currency: "GBP",
          ...facts,
        }),
      ).toStrictEqual({ ...PAID_SESSION, ...facts });
    });
  }

  // A free session captures no money, so it carries no provider resource id and
  // a zero charge is valid.
  it("builds a no-payment-required session with no resource id", () => {
    const build = validatedPaymentSession({
      amountTotal: 0,
      createdAt: undefined,
      currency: "GBP",
      id: "sess-free",
      metadata: meta,
      paymentReference: "",
      paymentStatus: "no_payment_required",
      provider: "stripe",
    });
    expect(isSessionRejection(build)).toBe(false);
    if (isSessionRejection(build)) return;
    expect(build.amountTotal).toBe(0);
    expect(paymentReferenceOf(build)).toBeNull();
    expect(() => paidPaymentReferenceOf(build)).toThrow(
      /^Paid session has no provider resource id$/u,
    );
  });

  it("fails if downstream code invents an invalid validated reference", () => {
    expect(() =>
      paymentReferenceOf({
        id: "invented",
        paymentReference: "   ",
        provider: "stripe",
      }),
    ).toThrow(/^Validated session has an invalid provider resource id$/u);
  });

  it("refuses to construct a session without a provider callback identity", () => {
    expect(() =>
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBP",
        id: "",
      }),
    ).toThrow(/^Payment session has an invalid provider resource id$/u);
  });

  // --- The refusals a live callback must make, at the one boundary they share ---

  // A paid charge the boundary cannot read is refused with a refundable
  // rejection carrying its reference, so the callback refunds it.
  it("refuses a fractional minor-unit amount with a refundable rejection", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 10.5,
        currency: "GBP",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
    expect(errorSpy.contains("malformed charge")).toBe(true);
  });

  it("unpacks a Square-packed record into the rejection", () => {
    // Square folds the small fields into one `b` entry to fit its ten-entry
    // cap, but the price proof is signed over the unpacked shape. A rejection
    // holding the packed record would fail its own ownership check, and a real
    // Square charge would be acknowledged instead of refunded.
    const build = validatedPaymentSession({
      ...basePaid,
      amountTotal: 10.5,
      currency: "GBP",
      metadata: wireMetadata({
        b: JSON.stringify({ date: "2026-08-01", phone: "07700900000" }),
        email: "a@example.com",
        items: "[]",
        name: "Alice",
        price_proof: "500.sig",
      }),
    });
    expect(isSessionRejection(build)).toBe(true);
    if (!isSessionRejection(build)) return;
    expect(build).toEqual({
      metadata: {
        ...unpackedMeta,
        date: "2026-08-01",
        email: "a@example.com",
        phone: "07700900000",
        price_proof: "500.sig",
      },
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  it("refuses a negative amount", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: -5,
        currency: "GBP",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  it("refuses a null amount", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: null,
        currency: "GBP",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  it("refuses a malformed currency the provider did give", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GB",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBPX",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  // An empty-string currency is a present (not missing) value that is not three
  // letters, so it is refused.
  it("refuses an empty-string currency", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  // A missing currency is not defaulted — a missing expected field is a hard no,
  // not a guess at the site's currency.
  it("refuses a missing currency", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: null,
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "pi_123",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "sess-1",
    });
  });

  // A malformed charge with no usable reference is not refundable: nothing can
  // be done with it at the provider.
  it("refuses a malformed charge with an unusable reference as non-refundable", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 10.5,
        currency: "GBP",
        paymentReference: "",
      }),
    ).toEqual({
      metadata: unpackedMeta,
      paymentReference: "",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: false,
      sessionId: "sess-1",
    });
  });

  for (const paymentReference of ["", "   "]) {
    it(`refuses a paid session with provider resource id ${JSON.stringify(paymentReference)}`, () => {
      expect(
        validatedPaymentSession({
          ...basePaid,
          amountTotal: 1000,
          currency: "GBP",
          paymentReference,
        }),
      ).toEqual({
        metadata: unpackedMeta,
        provider: "stripe",
        reason: "blank_reference",
        sessionId: "sess-1",
      });
      expect(errorSpy.contains("missing its provider resource id")).toBe(true);
    });
  }
});
