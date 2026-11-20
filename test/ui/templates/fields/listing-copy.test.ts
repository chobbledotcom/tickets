import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ListingCopyContext,
  listingCopyContext,
} from "#shared/listing-templates.ts";
import {
  type ListingCopy,
  listingCopy,
} from "#templates/fields/listing-copy.ts";

const wordsOf = (copy: ListingCopy): string[] => [
  copy.capacity,
  copy.document,
  copy.page,
  copy.people,
  copy.person,
  copy.pricingHeading,
  copy.unit,
  copy.unitTitle,
  copy.units,
];

describe("the listing copy", () => {
  test("maps each template id to its vocabulary", () => {
    expect(
      [
        undefined,
        null,
        "unknown",
        "custom",
        "physical-product",
        "online-digital",
        "hireable-item",
        "donation",
        "subscription",
        "one-off-event",
        "weekly-event",
        "day-pass",
      ].map(listingCopyContext),
    ).toEqual([
      "item",
      "item",
      "item",
      "item",
      "item",
      "item",
      "hire",
      "donation",
      "subscription",
      "ticket",
      "ticket",
      "ticket",
    ]);
  });

  test("names each vocabulary's words", () => {
    const contexts = [
      "ticket",
      "item",
      "hire",
      "donation",
      "subscription",
    ] as const satisfies readonly ListingCopyContext[];
    expect(
      contexts.map((context) => wordsOf(listingCopy(context)).join("|")),
    ).toEqual([
      "attendees|ticket|ticket page|attendees|attendee|Tickets & Pricing|ticket|Ticket|tickets",
      "items|order confirmation|listing page|buyers|buyer|Items & Pricing|item|Item|items",
      "items|order confirmation|listing page|customers|customer|Items & Pricing|item|Item|items",
      "donations|receipt|listing page|donors|donor|Donations & Pricing|donation|Donation|donations",
      "subscriptions|receipt|listing page|subscribers|subscriber|Subscriptions & Pricing|subscription|Subscription|subscriptions",
    ]);
  });
});
