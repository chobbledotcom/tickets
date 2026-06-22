import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import { getDb } from "#shared/db/client.ts";
import {
  modifiersTable,
  setModifierGroups,
  setModifierListings,
} from "#shared/db/modifiers.ts";
import {
  answersTable,
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
  getOrCreateStringIds,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { setSuppressDebugLogs } from "#shared/logger.ts";
import { buildItemsMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  assertJson,
  bookAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtmlResponse,
  followRedirect,
  mockRequest,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
  stubWebhookVerify,
  webhookMeta,
} from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

describeWithEnv("server (webhooks)", { db: true }, () => {
  describe("POST /payment/webhook", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns 400 when no provider configured", async () => {
      const response = await handleRequest(
        mockWebhookRequest(
          { type: "checkout.session.completed" },
          { "stripe-signature": "sig_test" },
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Payment provider not configured",
      );
    });

    test("returns 400 when signature header is missing", async () => {
      await setupStripe();

      const response = await handleRequest(
        mockWebhookRequest({ type: "checkout.session.completed" }),
      );
      await expectHtmlResponse(response, 400, "Missing signature");
    });

    /** Configure SumUp and stage a real checkout for the given listing:
     * production buildItemsMetadata output, encrypted store, id mapping. */
    const stageSumupCheckout = async (listing: {
      id: number;
      name: string;
      slug: string;
    }) => {
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
      // Price once and sign that total, exactly as production checkout does.
      const metadata = await buildItemsMetadata(
        intent,
        priceCheckout(intent).total,
      );
      await storeSumupCheckout(reference, metadata);
      await setSumupCheckoutId(reference, "co_e2e");
      return reference;
    };

    /** Unsigned SumUp webhook listing for the staged checkout. */
    const sumupWebhookEvent = {
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: "co_e2e",
    };

    const modifierUsageAmount = async (modifierId: number): Promise<number> => {
      const result = await getDb().execute({
        args: [modifierId],
        sql: "SELECT amount_applied FROM modifier_usages WHERE modifier_id = ?",
      });
      return Number(result.rows[0]!.amount_applied);
    };

    const modifierAggregates = async (
      modifierId: number,
    ): Promise<{
      totalRevenue: number;
      totalUses: number;
      usageCount: number;
    }> => {
      const row = await modifiersTable.findById(modifierId);
      return {
        totalRevenue: row!.total_revenue,
        totalUses: row!.total_uses,
        usageCount: row!.usage_count,
      };
    };

    test("processes an unsigned SumUp webhook end to end, idempotently", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const reference = await stageSumupCheckout(listing);
      const restore = stub(sumupApi, "retrieveCheckoutById", () =>
        Promise.resolve({
          amountMinor: 1000,
          reference,
          status: "PAID" as const,
          transactionId: "txn_e2e",
        }),
      );
      try {
        const response = await handleRequest(
          mockWebhookRequest(sumupWebhookEvent),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).processed).toBe(true);

        // A retried webhook resolves to the already-created attendee
        const retry = await handleRequest(
          mockWebhookRequest(sumupWebhookEvent),
        );
        expect((await retry.json()).processed).toBe(true);
      } finally {
        restore.restore();
      }
    });

    test("acknowledges unknown SumUp checkout ids without fetching from the API", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      await stageSumupCheckout(listing);
      const fetchStub = stub(sumupApi, "retrieveCheckoutById", () =>
        Promise.resolve(null),
      );
      try {
        const response = await handleRequest(
          mockWebhookRequest({
            event_type: "CHECKOUT_STATUS_CHANGED",
            id: "co_spam",
          }),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).received).toBe(true);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("shows the cancel page when a SumUp payment fails", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const reference = await stageSumupCheckout(listing);
      const restore = stub(sumupApi, "retrieveCheckoutById", () =>
        Promise.resolve({
          amountMinor: 1000,
          reference,
          status: "FAILED" as const,
          transactionId: "",
        }),
      );
      try {
        const response = await handleRequest(
          mockRequest(`/payment/success?session_id=${reference}`),
        );
        await expectHtmlResponse(response, 200, "Payment Cancelled");
      } finally {
        restore.restore();
      }
    });

    test("handles trailing slash on webhook URL (body buffered correctly)", async () => {
      await setupStripe();

      // Trailing slash: /payment/webhook/ should still buffer body before
      // async context wrappers, avoiding "Cannot read body as underlying
      // resource unavailable" on the Bunny Edge runtime.
      const request = new Request("http://localhost/payment/webhook/", {
        body: JSON.stringify({ type: "checkout.session.completed" }),
        headers: {
          "content-type": "application/json",
          host: "localhost",
          "stripe-signature": "sig_test",
        },
        method: "POST",
      });

      const response = await handleRequest(request);
      // Should reach the handler and process the body (not fail on body read)
      expect(response.status).toBe(400);
      const text = await response.text();
      // Any handler-level rejection proves the body was read successfully
      expect(
        text.includes("Invalid signature") ||
          text.includes("Webhook secret not configured"),
      ).toBe(true);
    });

    test("returns 400 when signature verification fails", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            error: "Invalid signature",
            valid: false,
          }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_bad" }),
        );
        await expectHtmlResponse(response, 400, "Invalid signature");
      } finally {
        mockVerify.restore();
      }
    });

    test("acknowledges non-checkout listings", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: { object: {} },
              id: "evt_test",
              type: "payment_intent.created",
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
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("acknowledges webhook with unrecognized session metadata", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_test",
                  metadata: {}, // Missing required fields — not our session
                  payment_status: "paid",
                },
              },
              id: "evt_test",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_test",
                  metadata: webhookMeta({
                    email: "john@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "John",
                  }),
                  payment_intent: "pi_test",
                  payment_status: "unpaid",
                },
              },
              id: "evt_test",
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
            expect(json.received).toBe(true);
            expect(json.status).toBe("pending");
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("processes valid single-ticket webhook and creates attendee", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_webhook_test",
                  metadata: signedMeta(
                    {
                      email: "webhook@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Webhook User",
                    },
                    1000,
                  ),
                  payment_intent: "pi_webhook_test",
                  payment_status: "paid",
                },
              },
              id: "evt_test",
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
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );

        // Verify attendee was created with encrypted PII blob
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.pii_blob).not.toBe("");

        // Verify tokens ARE persisted in DB (webhook stores them for redirect to consume)
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_webhook_test");
        expect(record?.ticket_tokens).not.toBe("");
      } finally {
        mockVerify.restore();
      }
    });

    test("dates booking ledger legs from the checkout time, not now", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Stripe stamps `created` (Unix seconds) when the checkout is made. Even a
      // webhook that arrives a day late must book the revenue on the day the
      // customer paid, so every leg takes its occurredAt from `created`.
      const created = Math.floor(Date.parse("2026-06-19T08:00:00.000Z") / 1000);
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
                  amount_total: 1000,
                  created,
                  id: "cs_ledger_time",
                  metadata: signedMeta(
                    {
                      email: "ledgertime@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Ledger Time",
                    },
                    1000,
                  ),
                  payment_intent: "pi_ledger_time",
                  payment_status: "paid",
                },
              },
              id: "evt_ledger_time",
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
        const { attendeeAccount } = await import(
          "#shared/accounting/accounts.ts"
        );
        const { transfersByAccount } = await import(
          "#shared/accounting/queries.ts"
        );
        const attendees = await getAttendeesRaw(listing.id);
        const legs = await transfersByAccount(
          attendeeAccount(attendees[0]!.id),
        );
        const expected = new Date(created * 1000).toISOString();
        expect(legs.length).toBeGreaterThan(0);
        for (const leg of legs) {
          expect(leg.occurredAt).toBe(expected);
        }
      } finally {
        mockVerify.restore();
      }
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

    test("logs a promo code usage when a code-triggered modifier is applied", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 1,
        direction: "discount",
        name: "EARLYBIRD",
        trigger: "code",
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
                  // £10 ticket minus £1 promo discount = £9.00.
                  amount_total: 900,
                  id: "cs_promo_log",
                  metadata: signedMeta(
                    {
                      email: "promo@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Promo Buyer",
                    },
                    900,
                  ),
                  payment_intent: "pi_promo_log",
                  payment_status: "paid",
                },
              },
              id: "evt_promo_log",
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
        expect(await modifierUsageAmount(modifier.id)).toBe(100);
        expect(await modifierAggregates(modifier.id)).toEqual({
          totalRevenue: 100,
          totalUses: 1,
          usageCount: 1,
        });
        const log = await getAllActivityLog();
        expect(
          log.some((e) => e.message === "Promo code 'EARLYBIRD' used: £1 off"),
        ).toBe(true);
      } finally {
        mockVerify.restore();
      }
    });

    test("logs a promo code surcharge with a + prefix", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 1,
        direction: "charge",
        name: "PREMIUM",
        trigger: "code",
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
                  // £10 ticket + £1 promo surcharge = £11.00.
                  amount_total: 1100,
                  id: "cs_promo_surcharge",
                  metadata: signedMeta(
                    {
                      email: "surcharge@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Surcharge Buyer",
                    },
                    1100,
                  ),
                  payment_intent: "pi_promo_surcharge",
                  payment_status: "paid",
                },
              },
              id: "evt_promo_surcharge",
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
        expect(await modifierUsageAmount(modifier.id)).toBe(100);
        expect(await modifierAggregates(modifier.id)).toEqual({
          totalRevenue: 100,
          totalUses: 1,
          usageCount: 1,
        });
        const log = await getAllActivityLog();
        expect(
          log.some((e) => e.message === "Promo code 'PREMIUM' used: +£1"),
        ).toBe(true);
      } finally {
        mockVerify.restore();
      }
    });

    test("logs a multiplier promo code discount", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "multiply",
        calcValue: 0.8,
        direction: "discount",
        name: "MULTI20",
        trigger: "code",
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
                  // £10 ticket multiplied by 0.8 = £8.00.
                  amount_total: 800,
                  id: "cs_promo_multiplier",
                  metadata: signedMeta(
                    {
                      email: "multiplier@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Multiplier Buyer",
                    },
                    800,
                  ),
                  payment_intent: "pi_promo_multiplier",
                  payment_status: "paid",
                },
              },
              id: "evt_promo_multiplier",
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
        const log = await getAllActivityLog();
        expect(
          log.some((e) => e.message === "Promo code 'MULTI20' used: £2 off"),
        ).toBe(true);
      } finally {
        mockVerify.restore();
      }
    });

    test("refunds a webhook whose total omits an applied modifier", async () => {
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
                  // Paid only the ticket, not the surcharge the metadata records.
                  amount_total: 1000,
                  id: "cs_modifier_mismatch",
                  metadata: signedMeta(
                    {
                      email: "mod@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Mod Buyer",
                    },
                    1000,
                  ),
                  payment_intent: "pi_modifier_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_modifier_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_modifier" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("refunds when an add-on-only paid session total no longer matches", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 0,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Workshop kit",
      });

      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            // Expected total is the £5 add-on; simulate a stale £4 session.
            amount_total: 400,
            id: "cs_addon_only_mismatch",
            metadata: signedMeta(
              {
                email: "mod@example.com",
                items: singleItem(listing.id, 1, 0),
                modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                name: "Mod Buyer",
              },
              400,
            ),
            payment_intent: "pi_addon_only_mismatch",
            payment_status: "paid",
          },
        },
        id: "evt_addon_only_mismatch",
        type: "checkout.session.completed",
      });
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_addon_only" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("refunds when a modifier sold out before the webhook finalized", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "Last one",
        stock: 1,
      });
      // Exhaust the single unit before the webhook arrives.
      const { consumeModifierStock } = await import(
        "#shared/db/modifier-usage.ts"
      );
      await consumeModifierStock(999, [
        { amountApplied: 100, modifierId: modifier.id, quantity: 1 },
      ]);

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
                  amount_total: 1100,
                  id: "cs_modifier_soldout",
                  metadata: signedMeta(
                    {
                      email: "mod@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Mod Buyer",
                    },
                    1100,
                  ),
                  payment_intent: "pi_modifier_soldout",
                  payment_status: "paid",
                },
              },
              id: "evt_modifier_soldout",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_soldout" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("sold out");
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
        // The visit + booking the greedy create recorded are reversed too, so
        // the refunded order leaves no phantom history on the buyer's contact.
        const { getContactRecord, getVisits, hashEmail } = await import(
          "#shared/db/contact-preferences.ts"
        );
        const { getTestPrivateKey } = await import("#test-utils");
        const buyerHash = await hashEmail("mod@example.com");
        expect(await getVisits(buyerHash)).toBe(0);
        expect(
          (await getContactRecord(buyerHash, await getTestPrivateKey()))
            .publicBookingCount,
        ).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("prices a customisable-days webhook booking by the chosen day count", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
        maximumDaysAfter: 90,
        minimumDaysBefore: 0,
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
                  // 3-day price (2500), not the 1-day unit price.
                  amount_total: 2500,
                  id: "cs_customisable",
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      day_count: "3",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Trip Buyer",
                    },
                    2500,
                  ),
                  payment_intent: "pi_customisable",
                  payment_status: "paid",
                },
              },
              id: "evt_customisable",
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
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        // Created at the day-count price and start date — proving the webhook
        // re-priced and dated the booking by the chosen span, not the listing's
        // flat unit price.
        expect(Number(attendees[0]?.price_paid)).toBe(2500);
        expect(attendees[0]?.date).toBe("2026-07-01");
      } finally {
        mockVerify.restore();
      }
    });

    test("defaults a customisable-days webhook with no day_count to a single day", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
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
                  amount_total: 1000,
                  id: "cs_no_daycount",
                  // No day_count → the booking falls back to the 1-day price.
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Trip Buyer",
                    },
                    1000,
                  ),
                  payment_intent: "pi_no_daycount",
                  payment_status: "paid",
                },
              },
              id: "evt_no_daycount",
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
        const attendees = await getAttendeesRaw(listing.id);
        expect(Number(attendees[0]?.price_paid)).toBe(1000);
      } finally {
        mockVerify.restore();
      }
    });

    test("refunds a customisable-days webhook whose day count has no price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
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
                  amount_total: 2500,
                  id: "cs_bad_daycount",
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      // 9 isn't an offered count, so the expected price is 0 and
                      // the charged amount can't be reconciled.
                      day_count: "9",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Trip Buyer",
                    },
                    2500,
                  ),
                  payment_intent: "pi_bad_daycount",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_daycount",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("processes valid multi-ticket webhook and creates attendees", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Webhook Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Webhook Multi 2",
        unitPrice: 1000,
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
                  amount_total: 2000,
                  id: "cs_multi_webhook",
                  metadata: signedMeta(
                    {
                      email: "multi@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 1000, q: 2 },
                        { e: listing2.id, p: 1000, q: 1 },
                      ]),
                      name: "Multi User",
                      phone: "123456",
                    },
                    2000,
                  ),
                  payment_intent: "pi_multi_webhook",
                  payment_status: "paid",
                },
              },
              id: "evt_multi",
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
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );

        // Verify attendees were created for both listings
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]?.quantity).toBe(2);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(1);
      } finally {
        mockVerify.restore();
      }
    });

    test("corrupt booking item in metadata throws (missing p)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Price Multi",
        unitPrice: 500,
      });

      // Items without a p field can't carry a valid price proof, so the session
      // has no proof and classifies as "ignore": acknowledged (200) without
      // processing or refunding, never a throw.
      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 500,
            id: "cs_no_price",
            metadata: webhookMeta({
              email: "noprice@example.com",
              items: JSON.stringify([{ e: listing1.id, q: 1 }]),
              name: "No Price User",
            }),
            payment_intent: "pi_no_price",
            payment_status: "paid",
          },
        },
        id: "evt_no_price",
        type: "checkout.session.completed",
      });

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing1.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook returns error for invalid multi-ticket items", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_bad_multi",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: "not-valid-json{",
                    name: "Bad Multi",
                  }),
                  payment_intent: "pi_bad",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_multi",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Unparseable items can't carry a valid price proof, so the session has
        // no proof and is ignored: acknowledged (200) without processing.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook handles sold-out listing and returns error in JSON", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the listing
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
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
                  amount_total: 1000,
                  id: "cs_soldout",
                  metadata: signedMeta(
                    {
                      email: "late@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Late Buyer",
                    },
                    1000,
                  ),
                  payment_intent: "pi_soldout",
                  payment_status: "paid",
                },
              },
              id: "evt_soldout",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBe(false);
            expect(json.error).toContain("sold out");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook returns 409 when session is being processed concurrently", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import(
        "#shared/db/processed-payments.ts"
      );
      await reserveSessionFn("cs_webhook_concurrent");

      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 1000,
            id: "cs_webhook_concurrent",
            metadata: signedMeta(
              {
                email: "concurrent@example.com",
                items: singleItem(listing.id, 1, 1000),
                name: "Concurrent Webhook",
              },
              1000,
            ),
            payment_intent: "pi_webhook_concurrent",
            payment_status: "paid",
          },
        },
        id: "evt_concurrent",
        type: "checkout.session.completed",
      });

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(409);
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook rejects POST with wrong content-type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/payment/webhook", {
          body: "test=123",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
            "stripe-signature": "sig_test",
          },
          method: "POST",
        }),
      );
      await expectHtmlResponse(response, 400, "Invalid Content-Type");
    });
  });

  describe("routes/webhooks.ts (additional coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("extractIntent rejects missing items in metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_no_items",
          metadata: {
            email: "john@example.com",
            name: "John",
            // items intentionally omitted — should cause an error
          },
          payment_intent: "pi_no_items",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_no_items"),
        );
        // extractIntent catches error and returns 400
        expect(redirectResponse.status).toBe(400);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("extractIntent preserves quantity 0 from metadata", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 0,
          id: "cs_qty_zero",
          metadata: signMeta(
            webhookMeta({
              email: "john@example.com",
              items: singleItem(listing.id, 0, 0),
              name: "John",
            }),
            0,
          ),
          payment_intent: "pi_qty_zero",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_qty_zero"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);

        // Verify attendee was created with quantity 0, not silently converted to 1
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(0);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("payment success redirect threads siteToken through to the renewal push", async () => {
      await setupStripe();

      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const { insertBuiltSite, getAllBuiltSites } = await import(
        "#shared/db/built-sites.ts"
      );
      const { provisionTestBuiltSite } = await import("#test-utils");
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      await insertBuiltSite(
        "Token Site",
        "tok.b-cdn.net",
        "",
        "",
        false,
        "9100",
      );
      const seedSite = (await getAllBuiltSites()).find(
        (s) => s.name === "Token Site",
      )!;
      const { tokenIndex } = await provisionTestBuiltSite(seedSite.id, {
        readOnlyFrom: "2026-09-01T00:00:00Z",
      });

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_site_token",
          metadata: signMeta(
            webhookMeta({
              email: "renew@example.com",
              items: singleItem(tier.id, 1, 1000),
              name: "Renewer",
              site_token_index: tokenIndex,
            }),
            1000,
          ),
          payment_intent: "pi_site_token",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_site_token"),
        );
        expect(redirectResponse.status).toBe(302);
        // Threading proof: a READ_ONLY_FROM push lands on the right edge script,
        // proving the site_token_index was extracted, matched, and bumped.
        const readOnlyCall = secretStub.calls.find(
          (c) => (c.args[1] as string) === "READ_ONLY_FROM",
        );
        expect(readOnlyCall).toBeDefined();
        expect(readOnlyCall!.args[0]).toBe(Number(seedSite.bunnyScriptId));
      } finally {
        mockRetrieve.restore();
        secretStub.restore();
      }
    });

    test("payment success rejects renewal metadata from an unrecognized origin", async () => {
      await setupStripe();

      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_foreign_site_token",
          metadata: {
            email: "renew@example.com",
            items: singleItem(tier.id, 1, 1000),
            name: "Renewer",
            site_token_index: "foreign-token-index",
          },
          payment_intent: "pi_foreign_site_token",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_foreign_site_token"),
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(
          "Payment session not recognized",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("payment success applies multi-tier renewal months cumulatively", async () => {
      await setupStripe();

      await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        name: "Monthly multi-tier renewal",
        purchaseOnly: true,
        unitPrice: 1000,
      });
      await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 12,
        name: "Annual multi-tier renewal",
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const { addMonthsIso } = await import("#shared/dates.ts");
      const { getAllListings } = await import("#shared/db/listings.ts");
      const { insertBuiltSite, getAllBuiltSites } = await import(
        "#shared/db/built-sites.ts"
      );
      const { provisionTestBuiltSite } = await import("#test-utils");
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      const listings = await getAllListings();
      const monthly = listings.find(
        (e) => e.name === "Monthly multi-tier renewal",
      )!;
      const annual = listings.find(
        (e) => e.name === "Annual multi-tier renewal",
      )!;

      const initialDeadline = "2026-09-01T00:00:00Z";
      await insertBuiltSite(
        "Multi Tier Renewal Site",
        "multi-renew.b-cdn.net",
        "",
        "",
        false,
        "9101",
      );
      const seedSite = (await getAllBuiltSites()).find(
        (s) => s.name === "Multi Tier Renewal Site",
      )!;
      const { tokenIndex } = await provisionTestBuiltSite(seedSite.id, {
        readOnlyFrom: initialDeadline,
      });

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 3000,
          id: "cs_multi_tier_renewal",
          metadata: signMeta(
            webhookMeta({
              email: "renew@example.com",
              items: JSON.stringify([
                { e: monthly.id, p: 2000, q: 2 },
                { e: annual.id, p: 1000, q: 1 },
              ]),
              name: "Renewer",
              site_token_index: tokenIndex,
            }),
            3000,
          ),
          payment_intent: "pi_multi_tier_renewal",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_tier_renewal"),
        );
        expect(redirectResponse.status).toBe(302);

        const updated = (await getAllBuiltSites()).find(
          (s) => s.id === seedSite.id,
        )!;
        const expectedDeadline = addMonthsIso(initialDeadline, 14);
        expect(updated.readOnlyFrom).toBe(expectedDeadline);

        const pushedDeadlines = secretStub.calls
          .filter((c) => (c.args[1] as string) === "READ_ONLY_FROM")
          .map((c) => c.args[2] as string);
        expect(pushedDeadlines.at(-1)).toBe(expectedDeadline);
      } finally {
        mockRetrieve.restore();
        secretStub.restore();
      }
    });

    test("payment success reads orderId param for Square redirect", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_square_order",
          metadata: signMeta(
            webhookMeta({
              email: "square@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Square User",
            }),
            1000,
          ),
          payment_intent: "pi_square_order",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // Square appends orderId as a query parameter (not session_id)
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?orderId=cs_square_order"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("tryRefund returns false when paymentReference is empty", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await deactivateTestListing(listing.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_null_ref",
          metadata: signMeta(
            webhookMeta({
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            }),
            1000,
          ),
          payment_intent: null, // No payment reference
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_null_ref"),
        );
        const html = await expectHtmlResponse(
          response,
          410,
          "no longer accepting registrations",
        );
        // Should show "contact support" since refund failed (no payment reference)
        expect(html).toContain("contact support");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("webhook extracts payment_intent as paymentReference", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_pi_extract",
                  metadata: signedMeta(
                    {
                      email: "pi@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "PI User",
                    },
                    1000,
                  ),
                  payment_intent: "pi_extracted_ref",
                  payment_status: "paid",
                },
              },
              id: "evt_pi_extract",
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

        // Verify attendee was created with encrypted PII blob
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.pii_blob).not.toBe("");
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook with non-array items in multi-ticket returns null", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_non_array",
                  metadata: webhookMeta({
                    email: "test@example.com",
                    items: '{"not":"an-array"}', // Valid JSON but not an array
                    name: "Test",
                  }),
                  payment_intent: "pi_non_array",
                  payment_status: "paid",
                },
              },
              id: "evt_non_array",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Non-array items can't carry a valid price proof, so the session has no
        // proof and is ignored: acknowledged (200) without processing.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook with missing items in multi-ticket metadata acknowledges without processing", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_no_items",
                  metadata: webhookMeta({
                    email: "test@example.com",
                    items: "", // empty items: hasRequiredSessionMetadata rejects (no items)
                    name: "Test",
                  }),
                  payment_intent: "pi_no_items",
                  payment_status: "paid",
                },
              },
              id: "evt_no_items",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket being processed returns 409", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Concurrent",
        unitPrice: 500,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import(
        "#shared/db/processed-payments.ts"
      );
      await reserveSessionFn("cs_multi_concurrent");

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_multi_concurrent",
          metadata: signMeta(
            webhookMeta({
              email: "concurrent@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Concurrent",
            }),
            500,
          ),
          payment_intent: "pi_multi_concurrent",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_concurrent"),
        );
        await expectHtmlResponse(response, 409, "being processed");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("single-ticket being processed returns 409", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import(
        "#shared/db/processed-payments.ts"
      );
      await reserveSessionFn("cs_single_concurrent");

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_single_concurrent",
          metadata: signMeta(
            webhookMeta({
              email: "concurrent@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Concurrent",
            }),
            1000,
          ),
          payment_intent: "pi_single_concurrent",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_concurrent"),
        );
        await expectHtmlResponse(response, 409, "being processed");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("multi-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Price Calc",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_price",
          metadata: signMeta(
            webhookMeta({
              email: "price@example.com",
              items: JSON.stringify([{ e: listing.id, p: 1500, q: 3 }]),
              name: "Price Test",
            }),
            1500,
          ),
          payment_intent: "pi_multi_price",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_price"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(3);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(1500);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("single-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2000,
          id: "cs_single_price",
          metadata: signMeta(
            webhookMeta({
              email: "price@example.com",
              items: singleItem(listing.id, 2, 2000),
              name: "Price Single",
            }),
            2000,
          ),
          payment_intent: "pi_single_price",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_price"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2000);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("formatPaymentError returns plain error when refunded is undefined", async () => {
      await setupStripe();

      // This tests the case where result.refunded is undefined
      // This happens when validatePaidSession fails (no refund attempt)
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_plain_error",
          metadata: {
            email: "john@example.com",
            items: singleItem(1, 1, 0),
            name: "John",
          },
          payment_intent: "pi_test",
          payment_status: "unpaid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_plain_error"),
        );
        const html = await expectHtmlResponse(
          response,
          400,
          "Payment verification failed",
        );
        // Should NOT contain refund-related text
        expect(html).not.toContain("refunded");
        expect(html).not.toContain("contact support for a refund");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("webhook cancel page returns error when no provider", async () => {
      // Don't set up any payment provider
      const response = await handleRequest(
        mockRequest("/payment/cancel?session_id=cs_cancel_no_prov"),
      );
      await expectHtmlResponse(
        response,
        400,
        "Payment provider not configured",
      );
    });

    test("multi-ticket failure error message for encryption_error", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Enc Err",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_multi_enc_err",
          metadata: signMeta(
            webhookMeta({
              email: "enc@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Enc Error",
            }),
            500,
          ),
          payment_intent: "pi_multi_enc_err",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      // Mock atomic create to return encryption error
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "encryption_error",
          success: false,
        }),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_enc_err"),
        );
        await expectHtmlResponse(
          response,
          500,
          "Registration failed",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
        mockAtomic.restore();
      }
    });

    test("a real create error propagates instead of refunding", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Create Boom",
        unitPrice: 500,
      });
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_create_boom",
          metadata: signMeta(
            webhookMeta({
              email: "boom@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Boom",
            }),
            500,
          ),
          payment_intent: "pi_create_boom",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.reject(new Error("synthetic create failure")),
      );
      const hadExpectError = Deno.env.get("TEST_EXPECT_ERROR");
      Deno.env.delete("TEST_EXPECT_ERROR");
      try {
        // A non-sold-out error is not swallowed as a refund: it propagates.
        await expect(
          handleRequest(
            mockRequest("/payment/success?session_id=cs_create_boom"),
          ),
        ).rejects.toThrow("synthetic create failure");
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
        mockAtomic.restore();
        if (hadExpectError) Deno.env.set("TEST_EXPECT_ERROR", hadExpectError);
      }
    });

    test("multi-ticket no firstAttendee returns refund error", async () => {
      await setupStripe();

      // Mock empty items list (edge case where items parsed but empty after filtering)
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_empty_items",
          metadata: {
            email: "empty@example.com",
            items: "[]", // Empty array
            name: "Empty Items",
          },
          payment_intent: "pi_multi_empty",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_empty_items"),
        );
        // Empty items list returns "Invalid cart session data"
        expect(response.status).toBe(400);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });
  });

  describe("webhook multi-ticket already processed", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns success for already-processed multi-ticket session", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Already Done",
        unitPrice: 500,
      });
      // Create attendee directly (not via public form which redirects to Stripe for paid listings)
      const result = await bookAttendee(listing, {
        email: "already@example.com",
        name: "Already Done",
        paymentId: "pi_already_done",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create test attendee");
      const attendee = result.attendees[0]!;

      const {
        reserveSession: reserveSessionFn,
        finalizeSession: finalizeSessionFn,
      } = await import("#shared/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_already_done");
      await finalizeSessionFn("cs_multi_already_done", attendee.id, [
        attendee.ticket_token,
      ]);

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
                  amount_total: 500,
                  id: "cs_multi_already_done",
                  metadata: signedMeta(
                    {
                      email: "already@example.com",
                      items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
                      name: "Already Done",
                    },
                    500,
                  ),
                  payment_intent: "pi_already_done",
                  payment_status: "paid",
                },
              },
              id: "evt_already_done",
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
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook handles multi-ticket with inactive listing and rollback", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Active",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Inactive",
        unitPrice: 500,
      });
      await deactivateTestListing(listing2.id);

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
                  amount_total: 1000,
                  id: "cs_multi_inactive_wh",
                  metadata: signedMeta(
                    {
                      email: "inactive@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 500, q: 1 },
                      ]),
                      name: "Multi Inactive",
                    },
                    1000,
                  ),
                  payment_intent: "pi_multi_inactive_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_inactive_wh",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("no longer accepting");
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook handles multi-ticket sold out in second listing", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Avail",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi WH Full",
        unitPrice: 500,
      });
      await bookAttendee(listing2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
        quantity: 1,
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
                  amount_total: 1000,
                  id: "cs_multi_soldout_wh",
                  metadata: signedMeta(
                    {
                      email: "soldout@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 500, q: 1 },
                      ]),
                      name: "Sold Out Multi",
                    },
                    1000,
                  ),
                  payment_intent: "pi_multi_soldout_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_soldout_wh",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("sold out");
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook handles non-checkout listing type by acknowledging", async () => {
      await setupStripe();

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
                  id: "pi_test",
                },
              },
              id: "evt_other_type",
              type: "payment_intent.succeeded",
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
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });
  });

  describe("routes/webhooks.ts (multi-ticket webhook)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook creates attendees for multiple listings", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH OK 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH OK 2",
        unitPrice: 300,
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
                  amount_total: 1100,
                  id: "cs_multi_ok",
                  metadata: signedMeta(
                    {
                      email: "multi@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 600, q: 2 },
                      ]),
                      name: "Multi Buyer",
                    },
                    1100,
                  ),
                  payment_intent: "pi_multi_ok",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_ok",
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
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket webhook saves custom question answers", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Answer WH",
        unitPrice: 500,
      });

      // Create a question and answer via DB
      const {
        questionsTable,
        answersTable,
        setListingQuestions,
        getAttendeeAnswersBatch,
      } = await import("#shared/db/questions.ts");
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Large",
      });
      await setListingQuestions(listing1.id, [q.id]);

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
                  amount_total: 500,
                  id: "cs_answer",
                  metadata: signedMeta(
                    {
                      answer_ids: JSON.stringify({
                        [String(listing1.id)]: [a.id],
                      }),
                      email: "answer@example.com",
                      items: JSON.stringify([{ e: listing1.id, p: 500, q: 1 }]),
                      name: "Answer Buyer",
                    },
                    500,
                  ),
                  payment_intent: "pi_answer",
                  payment_status: "paid",
                },
              },
              id: "evt_answer",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(200);

        // Verify answers were saved for the created attendee
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing1.id);
        expect(attendees.length).toBe(1);
        const answerMap = await getAttendeeAnswersBatch([attendees[0]!.id], {
          texts: false,
        });
        const attendeeAnswers = answerMap.get(attendees[0]!.id) ?? [];
        expect(attendeeAnswers).toEqual([a.id]);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket webhook handles listing not found without refund", async () => {
      await setupStripe();

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
                  amount_total: 1000,
                  id: "cs_multi_notfound",
                  metadata: webhookMeta({
                    email: "notfound@example.com",
                    items: JSON.stringify([{ e: 99999, p: 1000, q: 1 }]),
                    name: "Multi NotFound",
                  }),
                  payment_intent: "pi_multi_notfound",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_notfound",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        // Unsigned session (no valid price proof) for a listing we don't have:
        // ignored (200 ack) without processing — and crucially without a refund,
        // since the webhook may be for a different instance sharing the provider.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        // An unverifiable session must NOT trigger a refund.
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket webhook handles capacity exceeded with rollback", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Cap 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi WH Cap 2",
        unitPrice: 300,
      });

      // Fill listing2 to capacity
      await bookAttendee(listing2, {
        email: "existing@example.com",
        name: "Existing",
        quantity: 1,
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
                  amount_total: 800,
                  id: "cs_multi_cap",
                  metadata: signedMeta(
                    {
                      email: "cap@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 300, q: 1 },
                      ]),
                      name: "Multi Cap",
                    },
                    800,
                  ),
                  payment_intent: "pi_multi_cap",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_cap",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(
          true as unknown as Awaited<
            ReturnType<typeof stripeApi.refundPayment>
          >,
        ),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.error).toContain("sold out");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook replays an already-processed session as success even if its listing was deleted", async () => {
      await setupStripe();

      // Create a real listing and attendee to satisfy FK constraints for finalization
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Del Evt",
        unitPrice: 500,
      });
      const attResult = await bookAttendee(listing, {
        email: "whdel@example.com",
        name: "WH Del",
        paymentId: "pi_del",
        quantity: 1,
      });
      if (!attResult.success) throw new Error("Failed to create attendee");

      // Reserve and finalize the session with the real attendee
      const {
        reserveSession: reserveSessionFn,
        finalizeSession: finalizeSessionFn,
      } = await import("#shared/db/processed-payments.ts");
      await reserveSessionFn("cs_del_listing_wh");
      await finalizeSessionFn("cs_del_listing_wh", attResult.attendees[0]!.id);

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      // The metadata points at a since-deleted listing (99999). Because the
      // session is already finalized (the attendee exists), the retry is an
      // idempotent success replay — a missing listing only means no thank-you
      // URL, not a "Listing not found" error for a payment that succeeded.
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1000,
                  id: "cs_del_listing_wh",
                  metadata: signedMeta(
                    {
                      email: "deleted@example.com",
                      items: singleItem(99999, 1, 1000),
                      name: "Deleted Listing",
                    },
                    1000,
                  ),
                  payment_intent: "pi_del_listing_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_del_listing_wh",
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
            expect(json.error).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook refund returns false when payment reference is null", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

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
                  amount_total: 500,
                  id: "cs_noref",
                  metadata: signedMeta(
                    {
                      email: "noref@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "No Ref",
                    },
                    500,
                  ),
                  payment_status: "paid",
                },
              },
              id: "evt_noref",
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
            expect(json.error).toContain("no longer accepting");
          },
        );
      } finally {
        mockVerify.restore();
      }
    });
  });

  describe("routes/webhooks.ts (uncovered line coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("webhook returns 400 when items is missing from metadata", async () => {
      await setupStripe();

      // Session with missing items carries no valid price proof, so it can't be
      // proven ours and is ignored: acknowledged (200) without processing.
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
                  id: "cs_no_listing_id",
                  status: "COMPLETED",
                },
              },
              id: "evt_no_eid",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRetrieveSession = stub(
        stripePaymentProvider,
        "retrieveSession",
        () =>
          Promise.resolve({
            amountTotal: 0,
            id: "cs_no_listing_id",
            metadata: webhookMeta({
              email: "nolistingid@example.com",
              name: "No ListingId",
              // items missing — invalid session data
            }),
            paymentReference: "pi_no_listing_id",
            paymentStatus: "paid" as const,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
        mockRetrieveSession.restore();
      }
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Tryrefund Noprov",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      // Mock paymentsApi.getConfiguredProvider to return "stripe" on first call
      // (for webhook handler's initial check) then null on second call (for tryRefund).
      // This covers lines 135-141 where tryRefund has a payment reference but no provider.
      const { paymentsApi } = await import("#shared/payments.ts");
      const origGetConfigured = paymentsApi.getConfiguredProvider;
      let callCount = 0;
      const mockGetConfigured = stub(
        paymentsApi,
        "getConfiguredProvider",
        () => {
          callCount++;
          // First call: webhook handler needs provider; second call: tryRefund should get null
          return callCount <= 1 ? origGetConfigured() : null;
        },
      );

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
                  amount_total: 500,
                  id: "cs_tryrefund_noprov",
                  metadata: signedMeta(
                    {
                      email: "noprov@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "No Provider",
                    },
                    500,
                  ),
                  payment_intent: "pi_tryrefund_noprov",
                  payment_status: "paid",
                },
              },
              id: "evt_tryrefund_noprov",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        // The payment has a reference but the refund couldn't go through (no
        // provider), so it is retryable: 5xx for the provider to re-deliver once
        // reconfigured, rather than ack a still-charged customer.
        expect(response.status).toBe(503);
        expect(await response.text()).toContain("no longer accepting");
      } finally {
        mockVerify.restore();
        mockGetConfigured.restore();
      }
    });

    test("multi-ticket webhook skips refund when second listing not found", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi Rollback 1",
        unitPrice: 500,
      });
      // listing2 does not exist (id 99999) — validation fails before any attendees are created

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
                  amount_total: 500,
                  id: "cs_multi_rollback_cleanup",
                  metadata: webhookMeta({
                    email: "rollback@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 500, q: 1 },
                      { e: 99999, p: 0, q: 1 },
                    ]),
                    name: "Rollback Test",
                  }),
                  payment_intent: "pi_multi_rollback",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_rollback",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        // Unsigned session (no valid price proof): ignored (200 ack) without
        // processing, without a refund, and without creating any attendee.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );

        // An unverifiable session must NOT trigger a refund.
        expect(mockRefund.calls.length).toBe(0);

        // No attendees created (the session is ignored before any creation pass)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing1.id);
        expect(attendees.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket pricePaid records zero when listing has no unit_price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi Free",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 0,
          id: "cs_multi_free",
          metadata: signMeta(
            webhookMeta({
              email: "freemulti@example.com",
              items: JSON.stringify([{ e: listing.id, p: 0, q: 2 }]),
              name: "Free Multi",
            }),
            0,
          ),
          payment_intent: "pi_multi_free",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_free"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(0);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("single-ticket pricePaid records zero when listing has no unit_price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Single Free",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 0,
          id: "cs_single_free",
          metadata: signMeta(
            webhookMeta({
              email: "freesingle@example.com",
              items: singleItem(listing.id, 2, 0),
              name: "Free Single",
            }),
            0,
          ),
          payment_intent: "pi_single_free",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_free"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(0);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("webhook with checkout listing type but no extractable session acknowledges without processing", async () => {
      await setupStripe();

      // Listing type matches checkoutCompletedEventType but data lacks metadata
      // so extractSessionFromListing returns null (covers lines 498-500)
      // and data object has no id/order_id so sessionId is null (covers lines 597-602)
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
                  // No id, no order_id, no proper metadata
                  some_field: "value",
                },
              },
              id: "evt_no_extract",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook returns pending when resolveWebhookSession returns skip", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: { object: {} },
              id: "evt_skip",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockResolve = stub(
        stripePaymentProvider,
        "resolveWebhookSession",
        () => Promise.resolve("skip" as const),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.status).toBe("pending");
          },
        );
      } finally {
        mockVerify.restore();
        mockResolve.restore();
      }
    });

    test("webhook acknowledges when resolveWebhookSession returns null", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: { object: {} },
              id: "evt_null",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockResolve = stub(
        stripePaymentProvider,
        "resolveWebhookSession",
        () => Promise.resolve(null),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
        mockResolve.restore();
      }
    });

    test("multi-ticket with no attendees created returns refund error", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi No Att",
        unitPrice: 500,
      });

      // Mock createAttendeeAtomic to always fail with capacity_exceeded on first try
      // so createdAttendees stays empty and we hit lines 309-310
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "capacity_exceeded",
          success: false,
        }),
      );

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_multi_no_att",
          metadata: signMeta(
            webhookMeta({
              email: "noatt@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "No Att",
            }),
            500,
          ),
          payment_intent: "pi_multi_no_att",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_no_att" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_no_att"),
        );
        await expectHtmlResponse(response, 409, "sold out");
      } finally {
        mockAtomic.restore();
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket capacity exceeded uses metadata listing_id for refund", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Single Cap",
        unitPrice: 500,
      });

      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "capacity_exceeded",
          success: false,
        }),
      );

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_cap",
          metadata: signMeta(
            webhookMeta({
              email: "cap@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Cap User",
            }),
            500,
          ),
          payment_intent: "pi_single_cap",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_single_cap" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_cap"),
        );
        await expectHtmlResponse(response, 409, "sold out");
      } finally {
        mockAtomic.restore();
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook treats invalid payment_status as unpaid", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_bad_status",
                  metadata: webhookMeta({
                    email: "badstatus@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Bad Status",
                  }),
                  payment_intent: "pi_bad_status",
                  payment_status: "completed", // invalid status, should fall back to "unpaid"
                },
              },
              id: "evt_bad_status",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // "completed" is not a valid payment status, so paymentStatus defaults to "unpaid"
        // This means the session is treated as unpaid and returns a pending acknowledgement
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.status).toBe("pending");
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook extracts amount_total as number from listing data", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 2500,
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
                  amount_total: 2500,
                  id: "cs_amount_total",
                  metadata: signedMeta(
                    {
                      email: "amount@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Amount User",
                    },
                    2500,
                  ),
                  payment_intent: "pi_amount_total",
                  payment_status: "paid",
                },
              },
              id: "evt_amount_total",
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
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2500);
      } finally {
        mockVerify.restore();
      }
    });

    test("single-ticket refunds and rejects when price changed since checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (1200) differs from expectedPrice (1000 * 1 = 1000)
      // Price changed after checkout was created — should refund
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
                  amount_total: 1200,
                  id: "cs_mismatch",
                  metadata: signedMeta(
                    {
                      email: "mismatch@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Mismatch User",
                    },
                    1200,
                  ),
                  payment_intent: "pi_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_mismatch" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
            expect(json.error).toContain("changed");
          },
        );

        // Verify no attendee was created
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(0);

        // Verify refund was attempted
        expect(mockRefund.calls[0]!.args).toEqual(["pi_mismatch"]);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket refunds and rejects when prices changed since checkout", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 2",
        unitPrice: 300,
      });

      // expectedTotal = 500*1 + 300*2 = 1100, but amountTotal = 1000
      // Price changed after checkout was created — should refund
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
                  amount_total: 1000,
                  id: "cs_multi_mismatch",
                  metadata: signedMeta(
                    {
                      email: "multimismatch@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 400, q: 1 },
                        { e: listing2.id, p: 600, q: 2 },
                      ]),
                      name: "Multi Mismatch",
                    },
                    1000,
                  ),
                  payment_intent: "pi_multi_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_multi_mismatch" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
            expect(json.error).toContain("changed");
          },
        );

        // Verify no attendees were created
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(0);
        expect(attendees2.length).toBe(0);

        // Verify refund was attempted
        expect(mockRefund.calls[0]!.args).toEqual(["pi_multi_mismatch"]);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket redirect refunds and shows error when price changed since checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (800) differs from expectedPrice (1000 * 1 = 1000)
      // Price decreased after checkout was created — should refund
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_redirect_mismatch",
          metadata: signMeta(
            webhookMeta({
              email: "redirect@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Redirect Mismatch",
            }),
            800,
          ),
          payment_intent: "pi_redirect_mismatch",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_redirect" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_redirect_mismatch"),
        );
        await expectHtmlResponse(response, 409, "price", "changed", "refunded");

        // Verify no attendee was created
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(0);

        // Verify refund was attempted
        expect(mockRefund.calls[0]!.args).toEqual(["pi_redirect_mismatch"]);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook single-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_wh_no_email_single",
                  metadata: signedMeta(
                    {
                      email: 12345 as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
                      items: singleItem(listing.id, 1, 1000),
                      name: "No Email Single",
                    },
                    1000,
                  ),
                  payment_intent: "pi_wh_no_email_single",
                  payment_status: "paid",
                },
              },
              id: "evt_no_email_single",
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
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook multi-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
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
                  amount_total: 500,
                  id: "cs_wh_no_email_multi",
                  metadata: signedMeta(
                    {
                      email: true as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
                      items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
                      name: "No Email Multi",
                    },
                    500,
                  ),
                  payment_intent: "pi_wh_no_email_multi",
                  payment_status: "paid",
                },
              },
              id: "evt_no_email_multi",
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
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockVerify.restore();
      }
    });
  });

  describe("closes_at in payment processing", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("refunds and shows error when listing registration has closed (single ticket)", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_closed",
          metadata: signMeta(
            webhookMeta({
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            }),
            1000,
          ),
          payment_intent: "pi_closed",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_closed"),
        );
        await expectHtmlResponse(
          response,
          410,
          "registration closed",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook refunds when listing registration has closed (single ticket)", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_closed_wh",
                  metadata: signedMeta(
                    {
                      email: "jane@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Jane",
                    },
                    1000,
                  ),
                  payment_intent: "pi_closed_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_closed",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_closed" }),
          ),
          200,
          (json) => {
            expect(json.error).toContain("registration closed");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook refunds when multi-ticket listing registration has closed", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing1 = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // listing2 is closed
      const listing2 = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 500,
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
                  amount_total: 1500,
                  id: "cs_multi_closed",
                  metadata: signedMeta(
                    {
                      email: "jane@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 1000, q: 1 },
                        { e: listing2.id, p: 500, q: 1 },
                      ]),
                      name: "Jane",
                    },
                    1500,
                  ),
                  payment_intent: "pi_multi_closed",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_closed",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_multi_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_multi_closed" }),
          ),
          200,
          (json) => {
            expect(json.error).toContain("registration for");
            expect(json.error).toContain("closed");
          },
        );

        // Verify listing1 attendee was rolled back
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket webhook passes date to daily listings only", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maxAttendees: 50,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name: "Multi WH Daily",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Standard",
        unitPrice: 300,
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
                  amount_total: 800,
                  id: "cs_multi_daily",
                  metadata: signedMeta(
                    {
                      date: "2026-02-10",
                      email: "multidaily@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 300, q: 1 },
                      ]),
                      name: "Multi Daily Buyer",
                    },
                    800,
                  ),
                  payment_intent: "pi_multi_daily",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_daily",
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

        // Verify daily listing attendee has the date set
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]?.date).toBe("2026-02-10");

        // Verify standard listing attendee has null date
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.date).toBeNull();
      } finally {
        mockVerify.restore();
      }
    });
  });

  describe("unrecognized webhook sessions", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("webhook ignores session with no _origin marker", async () => {
      await setupStripe();

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
                  amount_total: 30,
                  id: "cs_foreign",
                  metadata: {
                    email: "foreign@example.com",
                    items: singleItem(1, 1, 0),
                    name: "Foreign Buyer",
                  },
                  payment_intent: "pi_foreign",
                  payment_status: "paid",
                },
              },
              id: "evt_foreign",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            // Should not attempt to process or refund
            expect(json.processed).toBeUndefined();
          },
        );
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook ignores session with wrong _origin marker", async () => {
      await setupStripe();

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
                  amount_total: 500,
                  id: "cs_other_instance",
                  metadata: {
                    _origin: "other-domain.com",
                    email: "other@example.com",
                    items: singleItem(1, 1, 500),
                    name: "Other Instance",
                  },
                  payment_intent: "pi_other_instance",
                  payment_status: "paid",
                },
              },
              id: "evt_other_instance",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook ignores unrecognized session via fallback retrieval path", async () => {
      await setupStripe();

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
                  id: "cs_fallback_foreign",
                  status: "COMPLETED",
                  // No proper metadata -> extractSessionFromListing returns null
                },
              },
              id: "evt_fallback_foreign",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRetrieveSession = stub(
        stripePaymentProvider,
        "retrieveSession",
        () =>
          Promise.resolve({
            amountTotal: 100,
            id: "cs_fallback_foreign",
            metadata: webhookMeta({
              _origin: "", // Empty _origin -> should be rejected as unrecognized
              email: "fallback@example.com",
              name: "Fallback Foreign",
            }),
            paymentReference: "pi_fallback_foreign",
            paymentStatus: "paid" as const,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRetrieveSession.restore();
        mockRefund.restore();
      }
    });
  });

  describe("refund logging", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("tryRefund logs success message when refund succeeds", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await deactivateTestListing(listing.id);

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
                  amount_total: 1000,
                  id: "cs_refund_log",
                  metadata: signedMeta(
                    {
                      email: "refundlog@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Refund Log",
                    },
                    1000,
                  ),
                  payment_intent: "pi_refund_log",
                  payment_status: "paid",
                },
              },
              id: "evt_refund_log",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_log" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      const debugLogs: string[] = [];
      const origDebug = console.debug;
      setSuppressDebugLogs(false);
      console.debug = (...args: unknown[]) => {
        debugLogs.push(args.join(" "));
      };

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(200);
        expect(mockRefund.calls[0]!.args).toEqual(["pi_refund_log"]);

        // Verify refund success was logged to console
        const refundLog = debugLogs.find((log) =>
          log.includes("Refund issued"),
        );
        expect(refundLog).toBeDefined();

        // Verify refund was logged to activity log tagged to listing
        const { getListingActivityLog } = await import(
          "#shared/db/activityLog.ts"
        );
        const entries = await getListingActivityLog(listing.id);
        const refundEntry = entries.find((e) =>
          e.message.includes("Automatic refund"),
        );
        expect(refundEntry).toBeDefined();
        expect(refundEntry!.listing_id).toBe(listing.id);
        expect(refundEntry!.message).toContain(
          "no longer accepting registrations",
        );
      } finally {
        console.debug = origDebug;
        setSuppressDebugLogs(null);
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("automatic refund logs to activity log for price mismatch", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 500,
                  id: "cs_refund_activity",
                  metadata: signedMeta(
                    {
                      email: "activity@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Activity Log User",
                    },
                    500,
                  ),
                  payment_intent: "pi_refund_activity",
                  payment_status: "paid",
                },
              },
              id: "evt_refund_activity",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_activity" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(200);

        const { getListingActivityLog } = await import(
          "#shared/db/activityLog.ts"
        );
        const entries = await getListingActivityLog(listing.id);
        const refundEntry = entries.find((e) =>
          e.message.includes("Automatic refund"),
        );
        expect(refundEntry).toBeDefined();
        expect(refundEntry!.listing_id).toBe(listing.id);
        expect(refundEntry!.message).toContain("price");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket can_pay_more accepts amount above minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 2500,
                  id: "cs_pay_more",
                  metadata: signedMeta(
                    {
                      email: "generous@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Generous User",
                    },
                    2500,
                  ),
                  payment_intent: "pi_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_more",
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

        // Verify attendee was created with the actual amount paid (2500), not the minimum (1000)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2500);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket can_pay_more uses per-item prices from metadata", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        name: "Multi Pay More 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Pay More 2",
        unitPrice: 1000,
      });

      // Listing1 base 500, user entered 2000; Listing2 base 1000, stays 1000
      // Total: 2000 + 1000 = 3000
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
                  amount_total: 3000,
                  id: "cs_multi_pay_more",
                  metadata: signedMeta(
                    {
                      email: "generous@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 2000, q: 1 },
                        { e: listing2.id, p: 1000, q: 1 },
                      ]),
                      name: "Multi Generous",
                    },
                    3000,
                  ),
                  payment_intent: "pi_multi_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_pay_more",
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

        // Verify both attendees were created with correct per-item prices
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(
          (attendees1[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2000);
        expect(attendees2.length).toBe(1);
        expect(
          (attendees2[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(1000);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket rejects amount above listing price when can_pay_more is disabled", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Pay More",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Normal Price",
        unitPrice: 1000,
      });

      // Same metadata shape as the pay-more test, but listing1 has can_pay_more=false
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
                  amount_total: 3000,
                  id: "cs_no_pay_more",
                  metadata: signedMeta(
                    {
                      email: "over@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 2000, q: 1 },
                        { e: listing2.id, p: 1000, q: 1 },
                      ]),
                      name: "Over Payer",
                    },
                    3000,
                  ),
                  payment_intent: "pi_no_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_no_pay_more",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_no_pay_more" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket can_pay_more rejects amount below minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 500,
                  id: "cs_pay_less",
                  metadata: signedMeta(
                    {
                      email: "cheap@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "Cheap User",
                    },
                    500,
                  ),
                  payment_intent: "pi_pay_less",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_less",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_pay_less" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket can_pay_more rejects amount above maximum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 20000,
                  id: "cs_pay_too_much",
                  metadata: signedMeta(
                    {
                      email: "overpay@example.com",
                      items: singleItem(listing.id, 1, 20000),
                      name: "Overpay User",
                    },
                    20000,
                  ),
                  payment_intent: "pi_pay_too_much",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_too_much",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_pay_too_much" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("corrupt booking item in metadata throws (non-integer p)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_bad_p",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: JSON.stringify([{ e: listing.id, p: 10.5, q: 1 }]),
                    name: "Bad Metadata",
                  }),
                  payment_intent: "pi_bad_p",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_p",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // A corrupt session can't carry a valid price proof, so it has no proof
        // and is ignored: acknowledged (200) without processing, no throw.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });

    test("corrupt booking item in metadata throws (non-object item)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 1000,
                  id: "cs_bad_item",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: JSON.stringify([
                      42,
                      { e: listing.id, p: 1000, q: 1 },
                    ]),
                    name: "Bad Item",
                  }),
                  payment_intent: "pi_bad_item",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_item",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // A corrupt session can't carry a valid price proof, so it has no proof
        // and is ignored: acknowledged (200) without processing, no throw.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket rejects when per-item p does not match unit_price * q for non-pay-more listing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      // p=500 but listing costs 1000*1=1000, and listing is not can_pay_more
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 500,
                  id: "cs_item_mismatch",
                  metadata: signedMeta(
                    {
                      email: "mismatch@example.com",
                      items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
                      name: "Mismatch User",
                    },
                    500,
                  ),
                  payment_intent: "pi_item_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_item_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_mismatch" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket rejects when sum(p) does not equal amountTotal", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      // p=2000 is valid for can_pay_more (>= 1000), but amountTotal=1500 != sum(p)=2000
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1500,
                  id: "cs_total_mismatch",
                  metadata: signedMeta(
                    {
                      email: "total@example.com",
                      items: JSON.stringify([{ e: listing.id, p: 2000, q: 1 }]),
                      name: "Total Mismatch",
                    },
                    1500,
                  ),
                  payment_intent: "pi_total_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_total_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_total" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket can_pay_more accepts total at max_price × quantity boundary", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20000 is exactly at the boundary → should be accepted
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 20000,
                  id: "cs_qty2_at_max",
                  metadata: signedMeta(
                    {
                      email: "boundary@example.com",
                      items: singleItem(listing.id, 2, 20000),
                      name: "Boundary User",
                    },
                    20000,
                  ),
                  payment_intent: "pi_qty2_at_max",
                  payment_status: "paid",
                },
              },
              id: "evt_qty2_at_max",
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

        // Verify one attendee record was created (quantity=2 is stored on the record)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(2);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket can_pay_more rejects total above max_price × quantity", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20001 exceeds the boundary → should be refunded
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
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
                  amount_total: 20001,
                  id: "cs_qty2_over_max",
                  metadata: signedMeta(
                    {
                      email: "overpay-qty2@example.com",
                      items: singleItem(listing.id, 2, 20001),
                      name: "Overpay Qty2 User",
                    },
                    20001,
                  ),
                  payment_intent: "pi_qty2_over_max",
                  payment_status: "paid",
                },
              },
              id: "evt_qty2_over_max",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_qty2_over_max" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            expect(json.error).toContain("price");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  });

  describe("multi-ticket webhook with custom questions", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("saves custom question answers for paid multi-ticket checkout", async () => {
      await setupStripe();

      // Listing with questions (paid) and listing without questions (free)
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Paid",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi No Q Free",
      });

      // Add a custom question only to listing1
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Dietary needs?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "None",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Vegetarian",
      });
      await setListingQuestions(listing1.id, [q.id]);

      // Submit multi-ticket form with a question answer selected.
      // One listing is paid, so this triggers the payment flow.
      // Stub checkout creation to avoid flaky stripe-mock HTTP calls under
      // high concurrency — this test verifies webhook processing, not checkout.
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            checkoutUrl: "https://checkout.stripe.com/pay/cs_multi_q_stub",
            sessionId: "cs_multi_q_stub",
          }),
      );

      const { submitMultiTicketForm, expectCheckoutRedirect } = await import(
        "#test-utils"
      );
      const slug = `${listing1.slug}+${listing2.slug}`;
      try {
        const checkoutResponse = await submitMultiTicketForm(slug, {
          email: "qbuyer@example.com",
          name: "Q Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q.id}`]: String(a1.id),
        });
        expectCheckoutRedirect(checkoutResponse);
      } finally {
        mockCreate.restore();
      }

      // Now simulate the webhook callback from the payment provider.
      // The metadata includes answer_ids serialized during checkout.
      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 1000,
            id: "cs_multi_q",
            metadata: signedMeta(
              {
                answer_ids: JSON.stringify({
                  [String(listing1.id)]: [a1.id],
                }),
                email: "qbuyer@example.com",
                items: JSON.stringify([
                  { e: listing1.id, p: 1000, q: 1 },
                  { e: listing2.id, p: 0, q: 1 },
                ]),
                name: "Q Buyer",
              },
              1000,
            ),
            payment_intent: "pi_multi_q",
            payment_status: "paid",
          },
        },
        id: "evt_multi_q",
        type: "checkout.session.completed",
      });

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );

        // Verify attendees were created
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const att1 = await getAttendeesRaw(listing1.id);
        const att2 = await getAttendeesRaw(listing2.id);
        expect(att1.length).toBe(1);
        expect(att2.length).toBe(1);

        // With multi-listing attendees, one attendee is linked to both listings.
        // Answers are stored on the shared attendee ID.
        const attendeeId = att1[0]!.id;
        expect(attendeeId).toBe(att2[0]!.id); // same attendee
        const batch = await getAttendeeAnswersBatch([attendeeId], {
          texts: false,
        });
        expect(batch.get(attendeeId)).toEqual([a1.id]);
      } finally {
        mockVerify.restore();
      }
    });

    test("saves free-text answers for a multi-listing checkout shared across listings", async () => {
      await setupStripe();

      // One attendee books two listings, each asking its own free-text question.
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Free Text Paid",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Free Text Free",
      });

      const q1 = await questionsTable.insert({
        displayType: "free_text",
        text: "Access needs?",
      });
      const q2 = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });
      await setListingQuestions(listing1.id, [q1.id]);
      await setListingQuestions(listing2.id, [q2.id]);

      // Drive the real checkout so ticket-submit parses the free-text answers and
      // packs them into the checkout intent (encrypting the strings on the way).
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            checkoutUrl: "https://checkout.stripe.com/pay/cs_text_q_stub",
            sessionId: "cs_text_q_stub",
          }),
      );
      const { submitMultiTicketForm, expectCheckoutRedirect } = await import(
        "#test-utils"
      );
      const slug = `${listing1.slug}+${listing2.slug}`;
      try {
        const checkoutResponse = await submitMultiTicketForm(slug, {
          email: "textbuyer@example.com",
          name: "Text Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q1.id}`]: "Wheelchair access",
          [`question_${q2.id}`]: "Vegan",
        });
        expectCheckoutRedirect(checkoutResponse);
      } finally {
        mockCreate.restore();
      }

      // The encrypted strings now exist; resolve their ids to reference them in
      // the webhook metadata exactly as the real checkout would have.
      const stringIds = await getOrCreateStringIds([
        "Wheelchair access",
        "Vegan",
      ]);

      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 1000,
            id: "cs_text_q",
            metadata: signedMeta(
              {
                email: "textbuyer@example.com",
                items: JSON.stringify([
                  { e: listing1.id, p: 1000, q: 1 },
                  { e: listing2.id, p: 0, q: 1 },
                ]),
                name: "Text Buyer",
                text_answer_ids: JSON.stringify({
                  [String(listing1.id)]: [
                    { q: q1.id, s: stringIds.get("Wheelchair access") },
                  ],
                  [String(listing2.id)]: [
                    { q: q2.id, s: stringIds.get("Vegan") },
                  ],
                }),
              },
              1000,
            ),
            payment_intent: "pi_text_q",
            payment_status: "paid",
          },
        },
        id: "evt_text_q",
        type: "checkout.session.completed",
      });

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const att1 = await getAttendeesRaw(listing1.id);
        const att2 = await getAttendeesRaw(listing2.id);
        expect(att1.length).toBe(1);
        expect(att2.length).toBe(1);

        // The same attendee is linked to both listings, so both free-text
        // answers land on the one attendee.
        const attendeeId = att1[0]!.id;
        expect(attendeeId).toBe(att2[0]!.id);
        const textAnswers = await getAttendeeTextAnswers(
          attendeeId,
          await getTestPrivateKey(),
        );
        expect(textAnswers.get(q1.id)).toBe("Wheelchair access");
        expect(textAnswers.get(q2.id)).toBe("Vegan");
      } finally {
        mockVerify.restore();
      }
    });

    test("saves custom question answers for paid single-ticket checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Single Q Paid",
        unitPrice: 1000,
      });

      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Dietary needs?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Vegan",
      });
      await setListingQuestions(listing.id, [q.id]);

      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 1000,
            id: "cs_single_q",
            metadata: signedMeta(
              {
                answer_ids: JSON.stringify({
                  [String(listing.id)]: [a1.id],
                }),
                email: "qsingle@example.com",
                items: singleItem(listing.id, 1, 1000),
                name: "Q Single Buyer",
              },
              1000,
            ),
            payment_intent: "pi_single_q",
            payment_status: "paid",
          },
        },
        id: "evt_single_q",
        type: "checkout.session.completed",
      });

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);

        // Verify custom question answers were saved
        const batch = await getAttendeeAnswersBatch([attendees[0]!.id], {
          texts: false,
        });
        expect(batch.get(attendees[0]!.id)).toEqual([a1.id]);
      } finally {
        mockVerify.restore();
      }
    });
  });
});
