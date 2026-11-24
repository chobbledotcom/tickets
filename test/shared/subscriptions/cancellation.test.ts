/** Cancellation must keep the booking identity even without paid renewals. */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, queryAll } from "#db/client.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { sql } from "#db/sql.ts";
import { getSubscribedRows } from "#db/subscriptions.ts";
import type { StripePaidInvoice } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  cancelOwnerSubscription,
  endFailedCheckoutSubscription,
} from "#shared/subscriptions/cancellation.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { MONTHLY, subscribe } from "#test-utils/db-helpers/subscriptions.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  stripePaidInvoice,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";

const withoutRenewals: readonly (readonly [string, StripePaidInvoice[]])[] = [
  ["no paid invoices", []],
  [
    "only the first invoice",
    [stripePaidInvoice({ billing_reason: "subscription_create" })],
  ],
  ["a zero-paid renewal", [stripePaidInvoice({ amount_paid: 0 })]],
];

const withCancellation = (
  invoices: StripePaidInvoice[],
  run: () => Promise<void>,
  beforeInvoices: () => Promise<void> = () => Promise.resolve(),
  status: "canceled" | "active" = "canceled",
) =>
  withMocks(
    () => ({
      cancel: stub(stripeApi, "cancelSubscription", (id) =>
        Promise.resolve({
          resource: stripeSubscription({ id, status }),
          status: "found" as const,
        }),
      ),
      invoices: stub(stripeApi, "readPaidInvoices", async () => {
        await beforeInvoices();
        return { resource: invoices, status: "found" as const };
      }),
    }),
    run,
  );

const expectNoRenewalMoney = async () =>
  expect(
    await queryAll(sql`SELECT * FROM transfers WHERE kind = 'payment'`),
  ).toEqual([]);

describeWithEnv("subscription cancellation identity", { db: true }, () => {
  for (const [name, invoices] of withoutRenewals) {
    test(`cancels with ${name} and records no renewal`, async () => {
      await subscribe("Ada", { ...MONTHLY, status: "active" });
      const [row] = await getSubscribedRows();
      await withCancellation(invoices, async () => {
        expect(await cancelOwnerSubscription(row!)).toBe("cancelled");
      });
      expect(await getSubscribedRows()).toEqual([
        { ...row, subscriptionStatus: "canceled" },
      ]);
      await expectNoRenewalMoney();
    });

    test(`refuses a replaced subscription with ${name}`, async () => {
      await subscribe("Ada", { ...MONTHLY, status: "active" });
      const [row] = await getSubscribedRows();
      await withCancellation(
        invoices,
        async () => {
          await expect(cancelOwnerSubscription(row!)).rejects.toThrow(
            "NOT NULL constraint failed: listing_attendees.listing_id",
          );
        },
        async () => {
          await execute(
            sql`UPDATE listing_attendees SET subscription_id = 'sub_replaced' WHERE id = ${row!.id}`,
          );
        },
      );
      expect(await getSubscribedRows()).toEqual([
        { ...row, subscriptionId: "sub_replaced" },
      ]);
      await expectNoRenewalMoney();
    });
  }

  for (const change of ["attendee", "listing", "id"] as const) {
    test(`refuses a replaced booking ${change} without paid invoices`, async () => {
      await subscribe("Ada", { ...MONTHLY, status: "active" });
      const [row] = await getSubscribedRows();
      const other = await subscribe("Ben", MONTHLY);
      await execute(
        sql`DELETE FROM listing_attendees WHERE attendee_id = ${other.attendeeId}`,
      );
      const replacements = {
        attendee: sql`UPDATE listing_attendees SET attendee_id = ${other.attendeeId} WHERE id = ${row!.id}`,
        id: sql`UPDATE listing_attendees SET id = ${row!.id + 1000} WHERE id = ${row!.id}`,
        listing: sql`UPDATE listing_attendees SET listing_id = ${other.listingId} WHERE id = ${row!.id}`,
      };
      let before = await getSubscribedRows();
      await withCancellation(
        [],
        async () => {
          await expect(cancelOwnerSubscription(row!)).rejects.toThrow(
            "NOT NULL constraint failed: listing_attendees.listing_id",
          );
        },
        async () => {
          await execute(replacements[change]);
          before = await getSubscribedRows();
        },
      );
      expect(await getSubscribedRows()).toEqual(before);
      await expectNoRenewalMoney();
    });
  }

  test("does no SQL work for an unchanged status without paid renewals", async () => {
    await subscribe("Ada", { ...MONTHLY, status: "active" });
    const [row] = await getSubscribedRows();
    await withCancellation(
      [],
      () =>
        withRequestContext(async () => {
          enableQueryLog();
          expect(await cancelOwnerSubscription(row!)).toBe("not_cancelled");
          expect(getQueryLog()).toEqual([]);
        }),
      undefined,
      "active",
    );
    expect(await getSubscribedRows()).toEqual([row]);
    await expectNoRenewalMoney();
  });

  test("refuses a failed checkout whose subscription Stripe still charges", async () => {
    await withMocks(
      () => ({
        cancel: stub(stripeApi, "cancelSubscription", () =>
          Promise.resolve({ status: "missing" as const }),
        ),
        read: stub(stripeApi, "readSubscription", (id: string) =>
          Promise.resolve({
            resource: stripeSubscription({ id, status: "active" }),
            status: "found" as const,
          }),
        ),
      }),
      async () => {
        await expect(
          endFailedCheckoutSubscription({
            amount: 600,
            id: "sub_failed",
            interval: "month",
            listingId: 1,
            status: "trialing",
          }),
        ).rejects.toThrow(
          "Failed checkout subscription sub_failed did not end",
        );
      },
    );
  });
});
