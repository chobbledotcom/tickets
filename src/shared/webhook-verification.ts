import type { ErrorCodeType } from "#shared/logger.ts";
import { parseWebhookPayload } from "#shared/payment-helpers.ts";
import type { WebhookEvent, WebhookVerifyResult } from "#shared/payments.ts";

/** Turn a signature check outcome into the standard verify result: a plain
 * failure when the signature did not match, or the parsed event when it did.
 * Each provider passes its own error code so a bad payload logs under the right
 * one. The caller logs the mismatch itself (the detail differs per provider);
 * this owns only the shared decision so the two providers can't drift. */
export const finishWebhookVerification = (
  matched: boolean,
  payload: string,
  errorCode: ErrorCodeType,
): WebhookVerifyResult =>
  matched
    ? // A provider that signs its webhooks posts the event itself.
      parseWebhookPayload(payload, errorCode, (body) => body as WebhookEvent)
    : { error: "Signature verification failed", valid: false };
