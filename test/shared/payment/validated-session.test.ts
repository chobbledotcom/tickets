import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  isSessionRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { BLANK_SESSION_METADATA } from "#test-utils/payment-session.ts";

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
};

describe("validatedPaymentSession", () => {
  // A refusal is observable as both a rejected build AND a logged error — the
  // spy is what catches a removed logError call.
  const errorSpy = setupErrorSpy();

  it("recognises a session rejection and nothing else", () => {
    expect(isSessionRejection({ reason: "blank_reference" })).toBe(true);
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
        reason: "malformed_charge",
        refundable: true,
      }),
    ).toBe(true);
    expect(isSessionRejection(null)).toBe(false);
    expect(isSessionRejection({ ok: true })).toBe(false);
    expect(isSessionRejection("skip")).toBe(false);
  });

  it("builds a paid session with a valid charge and resource id", () => {
    const build = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      currency: "gbp",
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.session.amountTotal).toBe(1000);
    expect(build.session.id).toBe("sess-1");
    expect(build.session.paymentReference).toBe("pi_123");
  });

  it("keeps a supplied creation time", () => {
    const createdAt = "2026-07-19T12:00:00.000Z";
    const build = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      createdAt,
      currency: "GBP",
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.session.createdAt).toBe(createdAt);
  });

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
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.session.amountTotal).toBe(0);
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      metadata: {
        b: JSON.stringify({ date: "2026-08-01", phone: "07700900000" }),
        email: "a@example.com",
        items: "[]",
        name: "Alice",
        price_proof: "500.sig",
      } as unknown as SessionMetadata,
    });
    expect(build.ok).toBe(false);
    if (build.ok) return;
    expect(build.rejection).toEqual({
      metadata: {
        ...unpackedMeta,
        date: "2026-08-01",
        email: "a@example.com",
        phone: "07700900000",
        price_proof: "500.sig",
      },
      paymentReference: "pi_123",
      reason: "malformed_charge",
      refundable: true,
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
    });
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBPX",
      }),
    ).toEqual({
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "pi_123",
        reason: "malformed_charge",
        refundable: true,
      },
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
      ok: false,
      rejection: {
        metadata: unpackedMeta,
        paymentReference: "",
        reason: "malformed_charge",
        refundable: false,
      },
    });
  });

  // A currency the provider gave that doesn't match the site's is carried on
  // the session: the callbacks refuse it (classify treats it as a mismatch and
  // refunds the captured charge) rather than dropping it here, so the money is
  // never stranded.
  it("builds a session carrying a non-site currency", () => {
    const build = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      currency: "USD",
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.session.currency).toBe("USD");
  });

  // A paid charge must name the provider resource that captured it; a blank id
  // names no charge to refund.
  it("refuses a paid session with a blank provider resource id", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBP",
        paymentReference: "",
      }),
    ).toEqual({ ok: false, rejection: { reason: "blank_reference" } });
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBP",
        paymentReference: "   ",
      }),
    ).toEqual({ ok: false, rejection: { reason: "blank_reference" } });
    expect(errorSpy.contains("provider resource id")).toBe(true);
  });
});
