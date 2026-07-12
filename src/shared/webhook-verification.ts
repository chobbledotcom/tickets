import type { ErrorCodeType } from "#shared/logger.ts";
import { parseWebhookPayload } from "#shared/payment-helpers.ts";
import type { WebhookVerifyResult } from "#shared/payments.ts";

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
    ? parseWebhookPayload(payload, errorCode)
    : { error: "Signature verification failed", valid: false };
