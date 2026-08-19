/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { isSessionRejection } from "#shared/payment/validated-session.ts";
import {
  buildSumupSession,
  resolveSumupCheckoutById,
  toSumupPaymentStatus,
} from "#shared/sumup/checkout-resolution.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupCheckout,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

describeWithEnv("sumup checkout resolution", { db: true }, () => {
  const debug = useDebugLogSpy();
  /** Ask the way the webhook asks. */
  const resolve = (id: string) => resolveSumupCheckoutById(id, "Webhook");

  test("reads a paid checkout back as a session to settle", async () => {
    const { reference } = await stageSignedSumupCheckout("co_ok");
    await makeSumupCheckoutDue("co_ok");
    const restore = withSumupCheckoutStatus(reference, "PAID", "txn_ok");
    try {
      const { reading, resolved } = await resolve("co_ok");

      expect(reading).toBe("PAID");
      expect(isSessionRejection(resolved)).toBe(false);
      expect(resolved).toMatchObject({
        id: reference,
        paymentStatus: "paid",
        provider: "sumup",
      });
    } finally {
      restore.restore();
    }
  });

  test("names the runner that asked in a refusal", async () => {
    // A recovery check's refusal must not read as a webhook's: which one
    // was running says whether a customer was waiting on the answer.
    await resolveSumupCheckoutById("", "SumUp");

    expect(debugLogged(debug, "[SumUp]")).toBe(true);
    expect(debugLogged(debug, "[Webhook]")).toBe(false);
  });

  test("keeps SumUp's own word for a checkout nobody has paid", async () => {
    // "skip" alone would lose the difference between not-yet and never, which
    // is the difference between asking again and closing the row.
    const { reference } = await stageSignedSumupCheckout("co_pending");
    const restore = withSumupCheckoutStatus(reference, "PENDING", "");
    try {
      const { reading, resolved } = await resolve("co_pending");

      expect(reading).toBe("PENDING");
      expect(resolved).toBe("skip");
    } finally {
      restore.restore();
    }
  });

  test("keeps SumUp's own word for a checkout that expired", async () => {
    const { reference } = await stageSignedSumupCheckout("co_expired");
    const restore = withSumupCheckoutStatus(reference, "EXPIRED", "");
    try {
      expect((await resolve("co_expired")).reading).toBe("EXPIRED");
    } finally {
      restore.restore();
    }
  });

  test("calls a read it could not make unusable, never unpaid", async () => {
    await stageSignedSumupCheckout("co_down");
    const restore = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        reason: "provider_error" as const,
        status: "unavailable" as const,
      }),
    );
    try {
      expect(await resolve("co_down")).toEqual({
        reading: "unusable",
        resolved: "retry",
      });
    } finally {
      restore.restore();
    }
  });

  test("refuses an id no staging write could have produced", async () => {
    const fetched = stub(sumupApi, "readCheckoutById");
    try {
      expect(await resolve("")).toEqual({
        reading: "unusable",
        resolved: "retry",
      });
      // Refused before it costs an API call.
      expect(fetched.calls).toHaveLength(0);
    } finally {
      fetched.restore();
    }
  });

  test("treats a 255-byte id like any other staged checkout", async () => {
    const longId = "x".repeat(255);
    const { reference } = await stageSignedSumupCheckout(longId);
    const restore = withSumupCheckoutStatus(reference, "PAID", "txn_long");
    try {
      const { resolved } = await resolve(longId);

      expect(resolved).toMatchObject({ id: reference, paymentStatus: "paid" });
    } finally {
      restore.restore();
    }
  });

  test("refuses an oversized id without reading anything, even when staged", async () => {
    // The bound is the cheap refusal — no staged-row lookup, no API call —
    // and a row carrying such an id must not change that.
    const longId = "x".repeat(256);
    const { reference } = await stageSignedSumupCheckout(longId);
    void reference;
    const fetched = stub(sumupApi, "readCheckoutById");
    try {
      expect(await resolve(longId)).toEqual({
        reading: "unusable",
        resolved: "retry",
      });
      expect(fetched.calls).toHaveLength(0);
    } finally {
      fetched.restore();
    }
  });

  test("refuses a checkout this site never staged", async () => {
    const fetched = stub(sumupApi, "readCheckoutById");
    try {
      expect((await resolve("co_stranger")).reading).toBe("unusable");
      expect(fetched.calls).toHaveLength(0);
    } finally {
      fetched.restore();
    }
  });

  test("keeps SumUp's word when its reference does not open our row", async () => {
    // SumUp contradicting itself about a checkout we created: we cannot read
    // the booking, but we still know it says the money was taken.
    await stageSignedSumupCheckout("co_wrong_ref");
    const restore = withSumupCheckoutStatus("not-our-reference", "PAID", "txn");
    try {
      expect(await resolve("co_wrong_ref")).toEqual({
        reading: "PAID",
        resolved: "retry",
      });
    } finally {
      restore.restore();
    }
  });
});

describeWithEnv("sumup session building", { db: false }, () => {
  test("maps SumUp's words to the shared payment words", () => {
    expect(toSumupPaymentStatus("PAID")).toBe("paid");
    expect(toSumupPaymentStatus("PENDING")).toBe("unpaid");
    expect(toSumupPaymentStatus("EXPIRED")).toBe("failed");
    expect(toSumupPaymentStatus("FAILED")).toBe("failed");
  });

  test("refuses a charge whose money the boundary cannot read", () => {
    // A paid charge with no amount must still reach the refund path, so this
    // is a rejection rather than a thrown-away read.
    const session = buildSumupSession(sumupCheckout({ amountMinor: null }), {
      email: "alice@example.com",
      items: '[{"e":1,"q":1,"p":0}]',
      name: "Alice",
    });

    expect(isSessionRejection(session)).toBe(true);
  });
});
