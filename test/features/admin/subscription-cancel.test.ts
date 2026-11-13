/** The owner cancels a subscription from the Subscriptions page. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { eventGroup } from "#accounting/refs.ts";
import { selectByEventGroup } from "#accounting/rows.ts";
import { execute, queryBatch, queryOne } from "#db/client.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { CANCELLABLE_STATUSES } from "#payment/subscription-machine-spec.ts";
import type { StripeSubscription } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  MONTHLY,
  subscribe,
  type TestBooking,
} from "#test-utils/db-helpers/subscriptions.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  createTestEditorSession,
  createTestManagerSession,
  postFormAs,
} from "#test-utils/session.ts";
import {
  stripePaidInvoice,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";

type SubscriptionRead = ProviderRead<StripeSubscription>;

const found =
  (status: StripeSubscription["status"]) =>
  (id: string): Promise<SubscriptionRead> =>
    Promise.resolve({
      resource: stripeSubscription({ id, status }),
      status: "found",
    });

const refused = (): Promise<SubscriptionRead> =>
  Promise.resolve({ status: "missing" });

/** Stripe's answers to the cancel and to the read after a refused cancel.
 * Each paid invoice list holds one renewal. */
type StripeAnswers = {
  cancel: (id: string) => Promise<SubscriptionRead>;
  read?: (id: string) => Promise<SubscriptionRead>;
};

type CancelMocks = {
  cancel: Stub;
  invoices: Stub;
  read: Stub;
};

const withStripe = (
  answers: StripeAnswers,
  body: (mocks: CancelMocks) => Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      cancel: stub(stripeApi, "cancelSubscription", answers.cancel),
      invoices: stub(stripeApi, "readPaidInvoices", () =>
        Promise.resolve({
          resource: [stripePaidInvoice({ id: "in_renewal" })],
          status: "found" as const,
        }),
      ),
      read: stub(stripeApi, "readSubscription", answers.read ?? refused),
    }),
    body,
  );

const bookingIdOf = async (booking: TestBooking): Promise<number> =>
  (await queryOne<{ id: number }>(
    "SELECT id FROM listing_attendees WHERE attendee_id = ?",
    [booking.attendeeId],
  ))!.id;

const statusOf = async (booking: TestBooking): Promise<string> =>
  (await queryOne<{ subscription_status: string }>(
    "SELECT subscription_status FROM listing_attendees WHERE attendee_id = ?",
    [booking.attendeeId],
  ))!.subscription_status;

const renewalLegCount = async (): Promise<number> =>
  (
    await selectByEventGroup(
      queryBatch,
      await eventGroup(["renewal", "in_renewal"]),
    )
  ).length;

const cancelPath = async (booking: TestBooking): Promise<string> =>
  `/admin/subscriptions/${await bookingIdOf(booking)}/cancel`;

const ownerCancel = async (booking: TestBooking): Promise<Response> =>
  (await adminFormPost(await cancelPath(booking))).response;

const expectBack = (message: string, succeeded: boolean) =>
  expectRedirectWithFlash("/admin/subscriptions", message, succeeded);

const expectCancelled = expectBack("Subscription cancelled.", true);

const expectNotCancelled = expectBack(
  "Stripe did not cancel the subscription. Please try again.",
  false,
);

/** The subscription ids each call of `mock` asked Stripe about. */
const askedAbout = (mock: Stub): unknown[][] =>
  mock.calls.map((call) => call.args);

describeWithEnv("server (cancel a subscription)", { db: true }, () => {
  for (const start of CANCELLABLE_STATUSES) {
    test(`an owner cancels a ${start} subscription and keeps its last payments`, async () => {
      const ada = await subscribe("Ada", { ...MONTHLY, status: start });
      await withStripe({ cancel: found("canceled") }, async (mocks) => {
        expectCancelled(await ownerCancel(ada));
        expect(askedAbout(mocks.cancel)).toEqual([["sub_ada"]]);
      });
      expect(await statusOf(ada)).toBe("canceled");
      expect(await renewalLegCount()).toBe(3);
      expect(await wasActivityLogged("Subscription sub_ada cancelled")).toBe(
        true,
      );
    });
  }

  test("refuses a subscription that already ended and asks Stripe nothing", async () => {
    const ada = await subscribe("Ada", { ...MONTHLY, status: "canceled" });
    await withStripe({ cancel: found("canceled") }, async (mocks) => {
      expectBack(
        "This subscription has already ended.",
        false,
      )(await ownerCancel(ada));
      expect(mocks.cancel.calls).toEqual([]);
    });
  });

  test("stores the end that Stripe reports when it refuses the cancel", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripe(
      { cancel: refused, read: found("canceled") },
      async (mocks) => {
        expectCancelled(await ownerCancel(ada));
        expect(askedAbout(mocks.read)).toEqual([["sub_ada"]]);
      },
    );
    expect(await statusOf(ada)).toBe("canceled");
  });

  test("stores a live status that Stripe reports after it refuses the cancel", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripe({ cancel: refused, read: found("past_due") }, async () => {
      expectNotCancelled(await ownerCancel(ada));
    });
    expect(await statusOf(ada)).toBe("past_due");
    expect(await wasActivityLogged("Subscription sub_ada cancelled")).toBe(
      false,
    );
  });

  test("changes nothing and reads no invoices when Stripe cannot answer", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripe({ cancel: refused }, async (mocks) => {
      expectNotCancelled(await ownerCancel(ada));
      expect(askedAbout(mocks.invoices)).toEqual([]);
    });
    expect(await statusOf(ada)).toBe("trialing");
  });

  test("keeps the cancel when the check writes a live status first", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    await withStripe(
      {
        cancel: async (id) => {
          // The scheduled check stores "active" while Stripe answers.
          await execute(
            "UPDATE listing_attendees SET subscription_status = 'active' WHERE attendee_id = ?",
            [ada.attendeeId],
          );
          return found("canceled")(id);
        },
      },
      async () => {
        expectCancelled(await ownerCancel(ada));
      },
    );
    expect(await statusOf(ada)).toBe("canceled");
  });

  test("answers not found for a booking without a subscription", async () => {
    const response = (await adminFormPost("/admin/subscriptions/999999/cancel"))
      .response;
    expect(response.status).toBe(404);
  });

  const staffCookies = {
    editor: async () => (await createTestEditorSession()).cookie,
    manager: () => createTestManagerSession(),
  };

  for (const [role, cookieOf] of Object.entries(staffCookies)) {
    test(`a ${role} cannot cancel`, async () => {
      const ada = await subscribe("Ada", MONTHLY);
      const cookie = await cookieOf();
      await withStripe({ cancel: found("canceled") }, async (mocks) => {
        expect((await postFormAs(await cancelPath(ada), cookie)).status).toBe(
          403,
        );
        expect(askedAbout(mocks.cancel)).toEqual([]);
      });
      expect(await statusOf(ada)).toBe("trialing");
    });
  }
});
