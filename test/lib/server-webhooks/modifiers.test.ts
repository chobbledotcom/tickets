// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  modifiersTable,
  setModifierGroups,
  setModifierListings,
} from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectModifierUsage,
  expectWebhookProcessed,
  setupStripe,
  signedMeta,
  singleItem,
  singleModifierMeta,
} from "#test-utils";
import { createServiceChargeScenario } from "./service-charge-scenario.ts";

// jscpd:ignore-end

/** Two listings (£10 / £25) for the in-scope-vs-out-of-scope modifier tests
 *  below — identical for both the listing-scoped and group-scoped variants,
 *  bar the group membership `extra1` layers onto the first listing. Created
 *  sequentially: `createTestListing` shares test-session state that a
 *  concurrent `Promise.all` would race. */
const createTwoListings = async (
  extra1: Record<string, unknown> = {},
): Promise<
  [
    Awaited<ReturnType<typeof createTestListing>>,
    Awaited<ReturnType<typeof createTestListing>>,
  ]
> => {
  const listing1 = await createTestListing({
    maxAttendees: 50,
    unitPrice: 1000,
    ...extra1,
  });
  const listing2 = await createTestListing({
    maxAttendees: 50,
    unitPrice: 2500,
  });
  return [listing1, listing2];
};

/** A 10%-charge modifier scoped to `scope`, for the listing-scoped vs
 *  group-scoped parallel test cases. */
const createScopedModifier = (name: string, scope: "groups" | "listings") =>
  modifiersTable.insert({
    calcKind: "percent",
    calcValue: 10,
    direction: "charge",
    name,
    scope,
  });

/** £20 (2×£10) in scope + £25 out of scope — the checkout line items shared
 *  by the listing-scoped and group-scoped parallel test cases. */
const scopeTestItems = (listing1Id: number, listing2Id: number): string =>
  JSON.stringify([
    { e: listing1Id, p: 2000, q: 2 },
    { e: listing2Id, p: 2500, q: 1 },
  ]);

describeWithEnv("server webhooks > modifiers", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("accepts a webhook whose total includes an applied modifier", async () => {
    await setupStripe();
    const { listing, modifier } = await createServiceChargeScenario();

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £10 ticket + 10% service charge = £11.00.
        amountTotal: 1100,
        eventId: "evt_modifier_ok",
        metadata: singleModifierMeta({
          amountTotal: 1100,
          listingId: listing.id,
          modifierId: modifier.id,
          unitPrice: 1000,
        }),
        paymentIntent: "pi_modifier_ok",
        sessionId: "cs_modifier_ok",
      }),
    );
    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    expect((await getAttendeesRaw(listing.id)).length).toBe(1);
  });

  test("records the in-scope amount for a listing-scoped modifier", async () => {
    await setupStripe();
    const [listing1, listing2] = await createTwoListings();
    const modifier = await createScopedModifier("Listing fee", "listings");
    await setModifierListings(modifier.id, [listing1.id]);

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £20 in-scope subtotal + £25 out-of-scope subtotal + £2 fee.
        amountTotal: 4700,
        eventId: "evt_listing_scope",
        metadata: signedMeta(
          {
            email: "scope@example.com",
            items: scopeTestItems(listing1.id, listing2.id),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Scope Buyer",
          },
          4700,
        ),
        paymentIntent: "pi_listing_scope",
        sessionId: "cs_listing_scope",
      }),
    );
    await expectModifierUsage(modifier.id, 200, {
      totalRevenue: 200,
      totalUses: 1,
      usageCount: 1,
    });
  });

  test("records the group-scoped amount for a grouped modifier", async () => {
    await setupStripe();
    const group = await createTestGroup({ maxAttendees: 50 });
    const [listing1, listing2] = await createTwoListings({
      groupId: group.id,
    });
    const modifier = await createScopedModifier("Group fee", "groups");
    await setModifierGroups(modifier.id, [group.id]);

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £20 grouped subtotal + £25 outside the group + £2 fee.
        amountTotal: 4700,
        eventId: "evt_group_scope",
        metadata: signedMeta(
          {
            email: "group@example.com",
            items: scopeTestItems(listing1.id, listing2.id),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Group Buyer",
          },
          4700,
        ),
        paymentIntent: "pi_group_scope",
        sessionId: "cs_group_scope",
      }),
    );
    await expectModifierUsage(modifier.id, 200, {
      totalRevenue: 200,
      totalUses: 1,
      usageCount: 1,
    });
  });

  test("records quantity-based add-on revenue through the aggregate trigger", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 5,
      direction: "charge",
      name: "VIP Lanyard",
      trigger: "optional",
    });

    await expectWebhookProcessed(
      checkoutSessionEvent({
        // £10 ticket + (£5 × 3 add-ons) = £25.00.
        amountTotal: 2500,
        eventId: "evt_modifier_quantity",
        metadata: signedMeta(
          {
            email: "addons@example.com",
            items: singleItem(listing.id, 1, 1000),
            modifiers: JSON.stringify([{ i: modifier.id, q: 3 }]),
            name: "Add-on Buyer",
          },
          2500,
        ),
        paymentIntent: "pi_modifier_quantity",
        sessionId: "cs_modifier_quantity",
      }),
    );
    await expectModifierUsage(modifier.id, 1500, {
      totalRevenue: 1500,
      totalUses: 3,
      usageCount: 1,
    });
  });
});
