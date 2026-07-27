import * as v from "valibot";
import { ProviderNoticeSchema } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import type { WebhookVerifyResult } from "#shared/payments.ts";
import type { VerifiedWebhookPayload } from "#shared/webhook-verification.ts";

export const providerNotice = (
  eventId: string,
  resource: ProviderResource,
  type: string,
): WebhookVerifyResult => ({
  notice: v.parse(ProviderNoticeSchema, { eventId, resource, type }),
  valid: true,
});

export const invalidProviderNotice = (error: string): WebhookVerifyResult => ({
  error,
  valid: false,
});

export const ignoredProviderNotice = (): WebhookVerifyResult => ({
  notice: null,
  valid: true,
});

export const parseVerifiedProviderNotice = <Schema extends v.GenericSchema>(
  verified: VerifiedWebhookPayload,
  schema: Schema,
  build: (value: v.InferOutput<Schema>) => WebhookVerifyResult,
): WebhookVerifyResult => {
  if (!verified.valid) return verified;
  const parsed = v.safeParse(schema, verified.value);
  return parsed.success
    ? build(parsed.output)
    : invalidProviderNotice("Invalid webhook payload");
};
