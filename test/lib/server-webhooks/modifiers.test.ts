import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  modifiersTable,
  setModifierGroups,
  setModifierListings,
} from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  modifierAggregates,
  modifierUsageAmount,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server webhooks > modifiers", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("accepts a webhook whose total includes an applied modifier", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Service charge",
    });

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £10 ticket + 10% service charge = £11.00.
                amount_total: 1100,
                id: "cs_modifier_ok",
                metadata: signedMeta(
                  {
                    email: "mod@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Mod Buyer",
                  },
                  1100,
                ),
                payment_intent: "pi_modifier_ok",
                payment_status: "paid",
              },
            },
            id: "evt_modifier_ok",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    } finally {
      mockVerify.restore();
    }
  });

  test("records the in-scope amount for a listing-scoped modifier", async () => {
    await setupStripe();
    const listing1 = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Listing fee",
      scope: "listings",
    });
    await setModifierListings(modifier.id, [listing1.id]);

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £20 in-scope subtotal + £25 out-of-scope subtotal + £2 fee.
                amount_total: 4700,
                id: "cs_listing_scope",
                metadata: signedMeta(
                  {
                    email: "scope@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 2000, q: 2 },
                      { e: listing2.id, p: 2500, q: 1 },
                    ]),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Scope Buyer",
                  },
                  4700,
                ),
                payment_intent: "pi_listing_scope",
                payment_status: "paid",
              },
            },
            id: "evt_listing_scope",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(200);
      expect(await modifierAggregates(modifier.id)).toEqual({
        totalRevenue: 200,
        totalUses: 1,
        usageCount: 1,
      });
    } finally {
      mockVerify.restore();
    }
  });

  test("records the group-scoped amount for a grouped modifier", async () => {
    await setupStripe();
    const group = await createTestGroup({ maxAttendees: 50 });
    const listing1 = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Group fee",
      scope: "groups",
    });
    await setModifierGroups(modifier.id, [group.id]);

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £20 grouped subtotal + £25 outside the group + £2 fee.
                amount_total: 4700,
                id: "cs_group_scope",
                metadata: signedMeta(
                  {
                    email: "group@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 2000, q: 2 },
                      { e: listing2.id, p: 2500, q: 1 },
                    ]),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                    name: "Group Buyer",
                  },
                  4700,
                ),
                payment_intent: "pi_group_scope",
                payment_status: "paid",
              },
            },
            id: "evt_group_scope",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(200);
      expect(await modifierAggregates(modifier.id)).toEqual({
        totalRevenue: 200,
        totalUses: 1,
        usageCount: 1,
      });
    } finally {
      mockVerify.restore();
    }
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

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                // £10 ticket + (£5 × 3 add-ons) = £25.00.
                amount_total: 2500,
                id: "cs_modifier_quantity",
                metadata: signedMeta(
                  {
                    email: "addons@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    modifiers: JSON.stringify([{ i: modifier.id, q: 3 }]),
                    name: "Add-on Buyer",
                  },
                  2500,
                ),
                payment_intent: "pi_modifier_quantity",
                payment_status: "paid",
              },
            },
            id: "evt_modifier_quantity",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(1500);
      expect(await modifierAggregates(modifier.id)).toEqual({
        totalRevenue: 1500,
        totalUses: 3,
        usageCount: 1,
      });
    } finally {
      mockVerify.restore();
    }
  });
});
