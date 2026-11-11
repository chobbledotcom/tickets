/**
 * How a customer buys a subscription ticket in a story. The Stripe client is
 * stubbed at its edge, so the site builds the real checkout. Stripe then
 * answers with exactly what the site asked for, as the real Stripe does when
 * it starts a subscription.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { queryAll } from "#db/client.ts";
import { sumOf } from "#fp";
import { nowSeconds } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import type {
  StripeCheckoutLineItemParams,
  StripeCheckoutSessionCreateParams,
} from "#shared/stripe/client.ts";
import {
  CUSTOMER,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  oneListingOrder,
  THANK_YOU,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  stripeCheckoutSession,
  stripeClient,
} from "#test-utils/stripe/fixtures.ts";
import {
  type StartedSubscription,
  withSubscriptionStarted,
} from "#test-utils/stripe/subscription-checkout.ts";

const SESSION_ID = "cs_subscription_story";

/** A checkout line Stripe charges again each period. */
type RecurringLine = {
  interval: "week" | "month" | "year";
  quantity: number;
  unitAmount: number;
};

const lineTotal = (line: StripeCheckoutLineItemParams): number =>
  line.price_data.unit_amount * line.quantity;

/** What the one-time lines of a checkout charge at once. */
export const chargedNow = (asked: StripeCheckoutSessionCreateParams): number =>
  sumOf(lineTotal)(
    asked.line_items.filter((line) => line.price_data.recurring === undefined),
  );

/** The lines of a checkout that Stripe charges again each period. */
export const chargedAgain = (
  asked: StripeCheckoutSessionCreateParams,
): RecurringLine[] =>
  asked.line_items.flatMap(({ price_data, quantity }) =>
    price_data.recurring === undefined
      ? []
      : [
          {
            interval: price_data.recurring.interval,
            quantity,
            unitAmount: price_data.unit_amount,
          },
        ],
  );

/** The customer presses Continue on the listing's own page, then pays. The
 * checkout the site sends to Stripe is kept as the customer's checkout. */
export const customerSubscribes = async (
  world: TicketsWorld,
  name: string,
  places: number,
): Promise<void> => {
  const client = await stripeClient();
  const choices = { email: "member@example.com", places, who: "Member" };
  const sentBefore = nowSeconds();
  const create = stub(client.checkout.sessions, "create", () =>
    Promise.resolve(stripeCheckoutSession({ id: SESSION_ID })),
  );
  try {
    await visitorTriesToOrder(
      ...oneListingOrder(listingNamed(world, name), choices),
      choices,
    );
  } finally {
    create.restore();
  }
  expect(create.calls.length).toBe(1);
  const { asked } = world.things.remember("checkout", CUSTOMER, {
    asked: create.calls[0]!.args[0],
    sentAfter: nowSeconds(),
    sentBefore,
  });
  await paysForSubscription(world, asked);
};

/** The subscription Stripe starts from the recurring line it was sent. */
const subscriptionStartedBy = (
  asked: StripeCheckoutSessionCreateParams,
): StartedSubscription["subscription"] => {
  const lines = chargedAgain(asked);
  expect(lines.length).toBe(1);
  const [{ interval, quantity, unitAmount }] = lines as [RecurringLine];
  const started = requireValue(
    asked.subscription_data,
    "A subscription checkout sent no subscription data",
  );
  return {
    id: "sub_story",
    items: {
      data: [
        {
          price: { recurring: { interval }, unit_amount: unitAmount },
          quantity,
        },
      ],
    },
    metadata: { ...started.metadata },
  };
};

/** The customer pays on Stripe. Stripe answers that the one-time lines were
 * paid and that the recurring line started a subscription. */
const paysForSubscription = async (
  world: TicketsWorld,
  asked: StripeCheckoutSessionCreateParams,
): Promise<void> => {
  const started = {
    session: {
      amount_total: chargedNow(asked),
      id: SESSION_ID,
      metadata: { ...asked.metadata },
    },
    subscription: subscriptionStartedBy(asked),
  };
  await withSubscriptionStarted(started, async () => {
    const browser = await openAsNewcomer(
      `/payment/success?session_id=${SESSION_ID}`,
    );
    rememberBrowser(world, CUSTOMER, browser);
    assertStringIncludes(browser.pageText, THANK_YOU);
  });
};

/** The plan each booking on a listing keeps, read from its booking row. */
export const plansOnBookings = (world: TicketsWorld, name: string) =>
  queryAll<{
    recurring_interval: string;
    recurring_price: number;
    recurring_tax: number;
    subscription_id: string;
  }>(
    `SELECT booking.recurring_price, booking.recurring_tax,
            booking.recurring_interval, booking.subscription_id
       FROM listing_attendees AS booking
      WHERE booking.listing_id = ?`,
    [listingNamed(world, name).id],
  );
