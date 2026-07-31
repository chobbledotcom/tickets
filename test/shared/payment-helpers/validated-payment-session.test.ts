import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { validatedPaymentSession } from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

/**
 * The provider boundary: every paid session the live callbacks read is built by
 * `validatedPaymentSession`, so this is the one place a malformed charge,
 * currency, or provider resource id is refused. A free session carries no
 * resource id, so a blank one is allowed only when no money was captured.
 */

const meta = { items: "[]", name: "Alice" } as SessionMetadata;
const basePaid = {
  createdAt: undefined,
  id: "sess-1",
  metadata: meta,
  paymentReference: "pi_123",
  paymentStatus: "paid" as const,
};

describe("validatedPaymentSession", () => {
  // A refusal is observable as both a null return AND a logged error — the
  // spy is what catches a removed logError call.
  const errorSpy = setupErrorSpy();

  it("builds a paid session with a valid charge and resource id", () => {
    const session = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      currency: "gbp",
    });
    expect(session).not.toBeNull();
    expect(session?.amountTotal).toBe(1000);
    expect(session?.id).toBe("sess-1");
    expect(session?.paymentReference).toBe("pi_123");
  });

  it("keeps a supplied creation time", () => {
    const createdAt = "2026-07-19T12:00:00.000Z";
    const session = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      createdAt,
      currency: "GBP",
    });
    expect(session?.createdAt).toBe(createdAt);
  });

  // A free session captures no money, so it carries no provider resource id and
  // a zero charge is valid.
  it("builds a no-payment-required session with no resource id", () => {
    const session = validatedPaymentSession({
      amountTotal: 0,
      createdAt: undefined,
      currency: "GBP",
      id: "sess-free",
      metadata: meta,
      paymentReference: "",
      paymentStatus: "no_payment_required",
    });
    expect(session).not.toBeNull();
    expect(session?.amountTotal).toBe(0);
  });

  // --- The refusals a live callback must make, at the one boundary they share ---

  it("refuses a fractional minor-unit amount", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 10.5,
        currency: "GBP",
      }),
    ).toBeNull();
    expect(errorSpy.contains("malformed charge")).toBe(true);
  });

  it("refuses a negative amount", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: -5,
        currency: "GBP",
      }),
    ).toBeNull();
  });

  it("refuses a null amount", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: null,
        currency: "GBP",
      }),
    ).toBeNull();
  });

  it("refuses a malformed currency the provider did give", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GB",
      }),
    ).toBeNull();
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBPX",
      }),
    ).toBeNull();
  });

  // An empty-string currency is a present (not missing) value that is not three
  // letters, so it is refused — this is what tells `??` (keeps "") apart from
  // `||` (would fall through to the site currency).
  it("refuses an empty-string currency", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "",
      }),
    ).toBeNull();
  });

  // A site has one currency, fixed at setup, so a charge the provider returns
  // without a currency is the site's — not refused, just settled to the one
  // currency the site uses.
  it("defaults a missing currency to the site's one currency", () => {
    const session = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      currency: null,
    });
    expect(session).not.toBeNull();
    expect(session?.amountTotal).toBe(1000);
  });

  // A paid charge with a blank resource id is NOT refused at the boundary — a
  // captured charge must be kept and surfaced, never dropped. The refund path
  // (tryRefund) is what refuses to act on a blank id (see refunds.test.ts).
  it("keeps a paid session whose provider resource id is blank", () => {
    const session = validatedPaymentSession({
      ...basePaid,
      amountTotal: 1000,
      currency: "GBP",
      paymentReference: "",
    });
    expect(session).not.toBeNull();
    expect(session?.paymentReference).toBe("");
  });
});
