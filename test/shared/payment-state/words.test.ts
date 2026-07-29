import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CASE_STATES,
  COMPLETION_STATES,
  DECISION_STATES,
  LEGACY_SOURCES,
  PAYMENT_MODES,
  PAYMENT_STATES,
  RECORD_ORIGINS,
  REFUND_STATES,
  RESOURCE_KIND_BY_PROVIDER,
  RESOURCE_KINDS,
  RESULT_STATES,
  TICKET_STATES,
} from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";

/**
 * These lists are the single source the tables and the code both read, so the
 * database and the code can never disagree about what a payment may say.
 * Pinning them here means a word cannot be added, removed, or renamed by
 * accident — every change has to be a deliberate one.
 */
describe("the words a payment record is allowed to use", () => {
  test("says where a payment has got to", () => {
    expect(PAYMENT_STATES).toEqual([
      "created",
      "pending",
      "ready",
      "processing",
      "completed",
      "failed",
      "refunding",
      "fully_refunded",
      "needs_action",
    ]);
  });

  test("says where a problem for the owner has got to", () => {
    expect(CASE_STATES).toEqual(["retrying", "needs_action", "resolved"]);
  });

  test("says where a refund has got to", () => {
    expect(REFUND_STATES).toEqual([
      "none",
      "requested",
      "pending",
      "partial",
      "completed",
      "failed",
      "unknown",
    ]);
  });

  test("says where the owner's decision has got to", () => {
    expect(DECISION_STATES).toEqual([
      "accepted",
      "running",
      "retrying",
      "completed",
    ]);
  });

  test("says how a payment turned out, and where its tickets are", () => {
    expect(RESULT_STATES).toEqual(["none", "succeeded", "failed"]);
    expect(TICKET_STATES).toEqual(["none", "ready", "consumed"]);
  });

  test("says whether the work after payment is still going", () => {
    expect(COMPLETION_STATES).toEqual([
      "none",
      "pending",
      "completed",
      "legacy_unknown",
    ]);
  });

  test("says whether a record was made here or copied across", () => {
    expect(RECORD_ORIGINS).toEqual(["current", "legacy"]);
  });

  test("says whether a payment was real money or a test", () => {
    expect(PAYMENT_MODES).toEqual(["test", "live"]);
  });

  test("says which old table a copied charge came from", () => {
    expect(LEGACY_SOURCES).toEqual([
      "processed_payments",
      "attendees.pii_blob",
      "attendee_merge",
    ]);
  });
});

describe("what each provider calls the money it took", () => {
  test("has a name for every provider the site can use", () => {
    // Keyed by provider rather than lined up beside it, so adding a provider
    // without saying what it calls its money is a compile error rather than a
    // silently mismatched pair.
    expect(Object.keys(RESOURCE_KIND_BY_PROVIDER).sort()).toEqual(
      [...PaymentProviderSchema.options].sort(),
    );
  });

  test("names each provider's money the way that provider does", () => {
    expect(RESOURCE_KIND_BY_PROVIDER).toEqual({
      square: "square_payment",
      stripe: "stripe_payment_intent",
      sumup: "sumup_transaction",
    });
  });

  test("takes the list of names from that same map", () => {
    expect(RESOURCE_KINDS).toEqual(Object.values(RESOURCE_KIND_BY_PROVIDER));
  });
});
