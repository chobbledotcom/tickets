/** One pass of the subscription status check: renewals reach the ledger with
 * their VAT, and each row keeps the status Stripe reports. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { eventGroup } from "#accounting/refs.ts";
import { selectByEventGroup } from "#accounting/rows.ts";
import { execute, queryBatch, queryOne } from "#db/client.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { stripeApi } from "#shared/stripe.ts";
import { SUBSCRIPTION_CHECK_BATCH } from "#shared/subscriptions/limits.ts";
import { runSubscriptionCheck } from "#shared/subscriptions/status-check.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  MONTHLY,
  subscribe,
  type TestBooking,
} from "#test-utils/db-helpers/subscriptions.ts";
import { rejection } from "#test-utils/ledger.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  stripePaidInvoice,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";
import { withStripeRenewals } from "#test-utils/stripe/subscription-checkout.ts";

/** What the task asked of the runner during one run. */
type RunRecord = { checkpoint: string | null; followUp: boolean };

/** Run one pass from `checkpoint` and report what it asked for next. */
const runCheck = async (checkpoint: string | null = null) => {
  const record: RunRecord = { checkpoint, followUp: false };
  const context: MaintenanceTaskContext = {
    budget: { remaining: () => ({ database: 99, external: 99, total: 99 }) },
    checkpoint,
    completeTask: () => {},
    deadline: Number.MAX_SAFE_INTEGER,
    requestFollowUp: () => {
      record.followUp = true;
    },
    setCheckpoint: (next) => {
      record.checkpoint = next;
    },
  };
  await runSubscriptionCheck(context);
  return record;
};

/** The legs one renewal invoice posted, as kind, from, to and amount. */
const renewalLegs = async (invoiceId: string) =>
  (
    await selectByEventGroup(
      queryBatch,
      await eventGroup(["renewal", invoiceId]),
    )
  )
    .map((leg) => ({
      amount: leg.amount,
      from: `${leg.source.type}:${leg.source.id}`,
      kind: leg.kind,
      occurredAt: leg.occurredAt,
      to: `${leg.destination.type}:${leg.destination.id}`,
    }))
    .sort((a, b) => String(a.kind).localeCompare(String(b.kind)));

const statusOf = async (booking: TestBooking): Promise<string> =>
  (await queryOne<{ subscription_status: string }>(
    "SELECT subscription_status FROM listing_attendees WHERE attendee_id = ?",
    [booking.attendeeId],
  ))!.subscription_status;

const PAID_AT = "2026-03-01T00:00:00.000Z";

/** The booking ended, and its last renewal `invoiceId` posted all three
 * legs. */
const expectEndedAfter = async (
  booking: TestBooking,
  invoiceId: string,
): Promise<void> => {
  expect(await renewalLegs(invoiceId)).toHaveLength(3);
  expect(await statusOf(booking)).toBe("canceled");
};

/** Run one pass while Stripe answers each subscription read with `answer`,
 * and each invoice list with what `paid` holds at that time. */
const checkWhileStripeAnswers = (
  answer: (id: string) => Promise<ReturnType<typeof stripeSubscription>>,
  paid: () => ReturnType<typeof stripePaidInvoice>[] = () => [],
): Promise<void> =>
  withMocks(
    () => ({
      invoices: stub(stripeApi, "readPaidInvoices", () =>
        Promise.resolve({ resource: paid(), status: "found" as const }),
      ),
      read: stub(stripeApi, "readSubscription", async (id: string) => ({
        resource: await answer(id),
        status: "found" as const,
      })),
    }),
    async () => {
      await runCheck();
    },
  );

describeWithEnv("subscription status check", { db: true }, () => {
  test("posts each renewal with its VAT on the day Stripe took it", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripeRenewals(
      "active",
      [
        stripePaidInvoice({ id: "in_cycle" }),
        stripePaidInvoice({
          billing_reason: "subscription_create",
          id: "in_first",
        }),
      ],
      async () => {
        await runCheck();
      },
    );
    const attendee = `attendee:${ada.attendeeId}`;
    expect(await renewalLegs("in_cycle")).toEqual([
      {
        amount: 600,
        from: "external:world",
        kind: "payment",
        occurredAt: PAID_AT,
        to: attendee,
      },
      {
        amount: 500,
        from: attendee,
        kind: "sale",
        occurredAt: PAID_AT,
        to: `revenue:${ada.listingId}`,
      },
      {
        amount: 100,
        from: attendee,
        kind: "vat",
        occurredAt: PAID_AT,
        to: "tax:vat",
      },
    ]);
    expect(await renewalLegs("in_first")).toEqual([]);
    expect(await statusOf(ada)).toBe("active");
  });

  test("keeps the share of VAT when Stripe takes a different amount", async () => {
    await subscribe("Ada", MONTHLY);
    await withStripeRenewals(
      "active",
      [stripePaidInvoice({ amount_paid: 300, id: "in_half" })],
      async () => {
        await runCheck();
      },
    );
    const amounts = (await renewalLegs("in_half")).map((leg) => leg.amount);
    expect(amounts).toEqual([300, 250, 50]);
  });

  test("posts no VAT leg for a plan without VAT", async () => {
    await subscribe("Ada", { ...MONTHLY, tax: 0 });
    await withStripeRenewals(
      "active",
      [stripePaidInvoice({ id: "in_no_vat" })],
      async () => {
        await runCheck();
      },
    );
    expect((await renewalLegs("in_no_vat")).map((leg) => leg.kind)).toEqual([
      "payment",
      "sale",
    ]);
  });

  test("posts one invoice once however often the check runs", async () => {
    await subscribe("Ada", MONTHLY);
    await withStripeRenewals(
      "active",
      [stripePaidInvoice({ id: "in_twice" })],
      async () => {
        await runCheck();
        await runCheck();
      },
    );
    expect(await renewalLegs("in_twice")).toHaveLength(3);
  });

  test("records the last renewals of a subscription that ended", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripeRenewals(
      "canceled",
      [stripePaidInvoice({ id: "in_last" })],
      async () => {
        await runCheck();
      },
    );
    await expectEndedAfter(ada, "in_last");
  });

  test("records the payment Stripe took just before it reported the end", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    let lastPaymentTaken = false;
    await checkWhileStripeAnswers(
      async (id) => {
        // Stripe takes the last payment while it answers, then reports the
        // end. An invoice list asked for before this answer misses it.
        await Promise.resolve();
        lastPaymentTaken = true;
        return stripeSubscription({ id, status: "canceled" });
      },
      () => (lastPaymentTaken ? [stripePaidInvoice({ id: "in_final" })] : []),
    );
    await expectEndedAfter(ada, "in_final");
  });

  test("leaves a status that changed after the check read the row", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await checkWhileStripeAnswers(async (id) => {
      // An owner cancel lands while Stripe answers the check.
      await execute(
        "UPDATE listing_attendees SET subscription_status = 'canceled' WHERE attendee_id = ?",
        [ada.attendeeId],
      );
      return stripeSubscription({ id, status: "past_due" });
    });
    expect(await statusOf(ada)).toBe("canceled");
  });

  test("moves on to the next subscription when Stripe cannot answer", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const bob = await subscribe("Bob", MONTHLY);
    const cy = await subscribe("Cy", MONTHLY);
    await withMocks(
      () => ({
        invoices: stub(stripeApi, "readPaidInvoices", (id: string) =>
          Promise.resolve(
            id === "sub_cy"
              ? ({ reason: "mismatched_money", status: "invalid" } as const)
              : ({ resource: [], status: "found" } as const),
          ),
        ),
        read: stub(stripeApi, "readSubscription", (id: string) =>
          Promise.resolve(
            id === "sub_ada"
              ? ({ reason: "timeout", status: "unavailable" } as const)
              : ({
                  resource: stripeSubscription({ id, status: "past_due" }),
                  status: "found",
                } as const),
          ),
        ),
      }),
      async () => {
        await runCheck();
      },
    );
    expect([
      await statusOf(ada),
      await statusOf(bob),
      await statusOf(cy),
    ]).toEqual(["trialing", "past_due", "trialing"]);
  });

  test("stops loudly when a renewal contradicts the legs it already posted", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const invoices = [stripePaidInvoice({ id: "in_changed" })];
    await withStripeRenewals("active", invoices, async () => {
      await runCheck();
      await execute(
        "UPDATE listing_attendees SET recurring_tax = 50, subscription_status = 'trialing' WHERE attendee_id = ?",
        [ada.attendeeId],
      );
      expect((await rejection(runCheck())).name).toBe("LedgerConflictError");
    });
    expect(await statusOf(ada)).toBe("trialing");
  });

  test("walks the rows in batches from the checkpoint", async () => {
    const bookings: TestBooking[] = [];
    for (const name of Array.from(
      { length: SUBSCRIPTION_CHECK_BATCH + 1 },
      (_, index) => `Member${index}`,
    )) {
      bookings.push(await subscribe(name, MONTHLY));
    }
    await withStripeRenewals("active", [], async () => {
      const first = await runCheck();
      expect(first.followUp).toBe(true);
      expect(first.checkpoint).not.toBeNull();
      expect(await statusOf(bookings.at(-1)!)).toBe("trialing");
      expect(await runCheck(first.checkpoint)).toEqual({
        checkpoint: null,
        followUp: false,
      });
    });
    expect(await statusOf(bookings.at(-1)!)).toBe("active");
  });
});
