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
  // letters, so it is refused.
  it("refuses an empty-string currency", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "",
      }),
    ).toBeNull();
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
    ).toBeNull();
  });

  // A currency the provider did give that doesn't match the site's one currency
  // is refused — the amount would be in the wrong unit for the site-currency
  // proof the callback checks.
  it("refuses a currency that does not match the site", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "USD",
      }),
    ).toBeNull();
    expect(errorSpy.contains("site currency")).toBe(true);
  });

  // A paid charge must name the provider resource that captured it; the old
  // per-provider parsing let a blank id through as a refundable charge.
  it("refuses a paid session with a blank provider resource id", () => {
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBP",
        paymentReference: "",
      }),
    ).toBeNull();
    expect(
      validatedPaymentSession({
        ...basePaid,
        amountTotal: 1000,
        currency: "GBP",
        paymentReference: "   ",
      }),
    ).toBeNull();
    expect(errorSpy.contains("provider resource id")).toBe(true);
  });
});
