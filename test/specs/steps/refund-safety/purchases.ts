import { Given } from "@cucumber/cucumber";
import { requiredMapValue } from "#fp";
import {
  buyPaidPlaceThroughPublicPage,
  type RefundStoryProvider,
} from "#test/specs/support/refund-safety/journeys.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

const PUBLIC_PAYMENT_PROVIDERS = new Map<string, RefundStoryProvider>([
  ["Stripe", "stripe"],
  ["SumUp", "sumup"],
]);

Given(
  "{word} bought a {float} {word} place through {word} on the public booking page",
  async function (
    this: TicketsWorld,
    who: string,
    pounds: number,
    listing: string,
    providerName: string,
  ): Promise<void> {
    const provider = requiredMapValue(
      PUBLIC_PAYMENT_PROVIDERS,
      providerName,
      `The refund story has no public ${providerName} journey`,
    );
    await buyPaidPlaceThroughPublicPage(
      this,
      who,
      pounds.toFixed(2),
      listing,
      provider,
    );
  },
);
