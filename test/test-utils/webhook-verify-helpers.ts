import * as v from "valibot";
import { handleRequest } from "#routes";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { stubWebhookVerify } from "#test-utils/settings.ts";

type VerifyEvent = Parameters<typeof stubWebhookVerify>[0];

const WebhookResponseSchema = v.object({
  error: v.optional(v.string()),
  processed: v.optional(v.boolean()),
  received: v.optional(v.boolean()),
  status: v.optional(v.string()),
});

/** Stub the webhook verify, POST the webhook, run assertions, and restore —
 *  the stub-post-assert-restore scaffold shared by every webhook-verify test. */
export const withWebhookVerify = async (
  event: VerifyEvent,
  assertions: (
    json: v.InferOutput<typeof WebhookResponseSchema>,
    status: number,
  ) => void | Promise<void>,
): Promise<void> => {
  const verify = await stubWebhookVerify(event);
  try {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    const json = v.parse(WebhookResponseSchema, await res.json());
    await assertions(json, res.status);
  } finally {
    verify.restore();
  }
};

/** Build a checkout.session.completed event from minimal inputs. */
export const webhookEvent = (opts: {
  amountTotal: number;
  eventId: string;
  metadata: Record<string, unknown>;
  paymentIntent?: string;
  paymentStatus?: string;
  sessionId: string;
}): VerifyEvent => ({
  data: {
    object: {
      amount_total: opts.amountTotal,
      created: 1_700_000_000,
      // Stripe sends the currency lower-cased; the boundary canonicalises it,
      // and refuses a session that carries none.
      currency: "gbp",
      id: opts.sessionId,
      livemode: false,
      metadata: opts.metadata,
      payment_intent: opts.paymentIntent ?? null,
      payment_status: opts.paymentStatus ?? "paid",
      url: null,
    },
  },
  id: opts.eventId,
  type: "checkout.session.completed" as const,
});
