// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

describeWithEnv("server > SumUp recovery", { db: true }, () => {
  /** Stage a real checkout the way production does, then make it due. */
  const stageDueCheckout = async (checkoutId: string): Promise<string> => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await settings.update.paymentProvider("sumup");
    await settings.update.sumup.apiKey("sk_test_x");
    await settings.update.sumup.merchantCode("MC1");
    setEffectiveDomainForTest("localhost");
    const reference = crypto.randomUUID();
    const intent: CheckoutIntent = {
      address: "",
      date: null,
      email: "alice@example.com",
      items: [
        {
          listingId: listing.id,
          name: listing.name,
          quantity: 1,
          slug: listing.slug,
          unitPrice: 1000,
        },
      ],
      name: "Alice",
      phone: "",
      special_instructions: "",
    };
    const metadata = await assembleCheckoutMetadata(
      "sumup",
      intent,
      priceCheckout(intent).total,
    );
    await storeSumupCheckout(reference, metadata);
    await setSumupCheckoutId(reference, checkoutId);
    // The first check is hours out; bring it forward rather than waiting.
    await execute(
      "UPDATE sumup_checkouts SET next_check_at = ? WHERE sumup_id = ?",
      ["2000-01-01T00:00:00.000Z", checkoutId],
    );
    return reference;
  };

  const readCheckout = (
    reference: string,
    status: "EXPIRED" | "FAILED" | "PAID" | "PENDING",
  ) =>
    stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        resource: {
          amountMinor: 1000,
          currency: "GBP",
          reference,
          status,
          transactionId: "txn_recovered",
        },
        status: "found" as const,
      }),
    );

  const stateOf = async (checkoutId: string) => {
    const row = await queryOne<{
      next_check_at: string | null;
      recovery_state: string;
    }>(
      "SELECT recovery_state, next_check_at FROM sumup_checkouts WHERE sumup_id = ?",
      [checkoutId],
    );
    if (!row) throw new Error(`No staged checkout ${checkoutId}`);
    return row;
  };

  const attendeeCount = async (): Promise<number> =>
    (await queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM attendees"))[0]!
      .n;

  test("books a paid checkout whose callback never arrived", async () => {
    // The whole point of the feature: SumUp took the money, the one callback
    // was lost, and nothing else would ever have asked.
    const reference = await stageDueCheckout("co_lost");
    const restore = readCheckout(reference, "PAID");
    try {
      expect(await attendeeCount()).toBe(0);

      await runSumupRecovery();

      expect(await attendeeCount()).toBe(1);
      const row = await stateOf("co_lost");
      expect(row.recovery_state).toBe("finished");
      // Finished rows are never asked about again.
      expect(row.next_check_at).toBeNull();
    } finally {
      restore.restore();
    }
  });

  test("books it exactly once when the check runs twice", async () => {
    const reference = await stageDueCheckout("co_twice");
    const restore = readCheckout(reference, "PAID");
    try {
      await runSumupRecovery();
      // The row is finished, so the second run does not even select it.
      await execute(
        "UPDATE sumup_checkouts SET recovery_state = 'waiting', next_check_at = ? WHERE sumup_id = ?",
        ["2000-01-01T00:00:00.000Z", "co_twice"],
      );
      await runSumupRecovery();

      expect(await attendeeCount()).toBe(1);
      expect((await stateOf("co_twice")).recovery_state).toBe("finished");
    } finally {
      restore.restore();
    }
  });

  test("closes a checkout SumUp says was never paid", async () => {
    const reference = await stageDueCheckout("co_expired");
    const restore = readCheckout(reference, "EXPIRED");
    try {
      await runSumupRecovery();

      expect(await attendeeCount()).toBe(0);
      const row = await stateOf("co_expired");
      expect(row.recovery_state).toBe("unpaid");
      expect(row.next_check_at).toBeNull();
    } finally {
      restore.restore();
    }
  });

  test("asks again about a checkout nobody has paid yet", async () => {
    const reference = await stageDueCheckout("co_pending");
    const restore = readCheckout(reference, "PENDING");
    try {
      await runSumupRecovery();

      const row = await stateOf("co_pending");
      expect(row.recovery_state).toBe("waiting");
      // Still open, and moved out of the way of rows due before it: the next
      // check is hours ahead, not the moment in the past it was given.
      const dueAgainAt = Date.parse(row.next_check_at ?? "");
      expect(Number.isNaN(dueAgainAt)).toBe(false);
      expect(dueAgainAt).toBeGreaterThan(Date.now());
    } finally {
      restore.restore();
    }
  });

  test("keeps asking when SumUp cannot answer, and never calls it unpaid", async () => {
    // An outage must never be read as "the customer did not pay" — that is
    // the reading that would delete a paid checkout.
    await stageDueCheckout("co_outage");
    const restore = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        reason: "provider_error" as const,
        status: "unavailable" as const,
      }),
    );
    try {
      await runSumupRecovery();

      expect((await stateOf("co_outage")).recovery_state).toBe("waiting");
    } finally {
      restore.restore();
    }
  });

  test("leaves a row alone when another runner answered it first", async () => {
    const reference = await stageDueCheckout("co_raced");
    const restore = readCheckout(reference, "PAID");
    try {
      const { getDueSumupCheckouts, applySumupRecoveryEvent } = await import(
        "#shared/db/sumup-recovery.ts"
      );
      const due = await getDueSumupCheckouts();
      const seen = due[0];
      if (!seen) throw new Error("The staged checkout was not due");
      // Another runner answers the row between our read and our write.
      await execute(
        "UPDATE sumup_checkouts SET recovery_state = 'finished', next_check_at = NULL WHERE sumup_id = ?",
        ["co_raced"],
      );

      expect(await applySumupRecoveryEvent(seen, "read_pending")).toBe(false);
      // The winner's answer stands.
      expect((await stateOf("co_raced")).recovery_state).toBe("finished");
    } finally {
      restore.restore();
    }
  });
});
