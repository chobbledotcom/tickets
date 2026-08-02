import { handleRequest } from "#routes";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { stubWebhookVerify } from "#test-utils/settings.ts";

type VerifyEvent = Parameters<typeof stubWebhookVerify>[0];

/** Stub the webhook verify, POST the webhook, run assertions, and restore —
 *  the stub-post-assert-restore scaffold shared by every webhook-verify test. */
export const withWebhookVerify = async (
  event: VerifyEvent,
  assertions: (json: Record<string, unknown>) => void | Promise<void>,
): Promise<void> => {
  const verify = await stubWebhookVerify(event);
  try {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    await assertions(json);
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
      id: opts.sessionId,
      metadata: opts.metadata,
      payment_intent: opts.paymentIntent ?? null,
      payment_status: opts.paymentStatus ?? "paid",
      url: null,
    },
  },
  id: opts.eventId,
  type: "checkout.session.completed" as const,
});
