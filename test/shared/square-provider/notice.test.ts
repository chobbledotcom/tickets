import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import type { WebhookVerifyResult } from "#shared/payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { constructTestSquareWebhook } from "#shared/square-webhook.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { session } from "#test/shared/square-provider/fixtures.ts";

const SECRET = "square-provider-notice-branches";
const WEBHOOK_URL = "https://example.com/payment/webhook";

const verifyNotice = async (event: unknown): Promise<WebhookVerifyResult> => {
  await settings.update.square.webhookSignatureKey(SECRET);
  const { payload, signature } = await constructTestSquareWebhook(
    event,
    SECRET,
    WEBHOOK_URL,
  );
  return squarePaymentProvider.verifyWebhookSignature(
    payload,
    signature,
    WEBHOOK_URL,
    new TextEncoder().encode(payload),
  );
};

const payment = {
  id: "pay-notice",
  order_id: session.id,
  status: "COMPLETED",
};

describeSquare(() => {
  test("ignores a signed Square event that is not a payment update", async () => {
    expect(
      await verifyNotice({
        data: { object: payment },
        event_id: "event-ignored",
        type: "payment.created",
      }),
    ).toEqual({ notice: null, valid: true });
  });

  test("reads the nested payment and fallback event id", async () => {
    expect(
      await verifyNotice({
        data: { object: { payment } },
        id: "event-fallback",
        type: "payment.updated",
      }),
    ).toEqual({
      notice: {
        eventId: "event-fallback",
        resource: {
          id: payment.id,
          kind: "square_payment",
          parentId: session.id,
          provider: "square",
        },
        type: "payment.updated",
      },
      valid: true,
    });
  });

  test("rejects a payment update without an event id", async () => {
    expect(
      await verifyNotice({
        data: { object: payment },
        type: "payment.updated",
      }),
    ).toEqual({
      error: "Square webhook is missing event id",
      valid: false,
    });
  });

  test("reports that Square webhooks need manual setup", async () => {
    expect(
      await squarePaymentProvider.setupWebhookEndpoint(
        "unused-secret",
        WEBHOOK_URL,
      ),
    ).toEqual({
      error:
        "Square webhooks must be configured manually in the Square Developer Dashboard",
      success: false,
    });
  });
});
