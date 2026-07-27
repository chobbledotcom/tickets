import { errorMessage } from "#shared/error-message.ts";
import { type ErrorCodeType, logError } from "#shared/logger.ts";

export type VerifiedWebhookPayload =
  | { valid: true; value: unknown }
  | { error: string; valid: false };

/** Turn a signature check outcome into the standard verify result: a plain
 * failure when the signature did not match, or the parsed event when it did.
 * Each provider passes its own error code so a bad payload logs under the right
 * one. The caller logs the mismatch itself (the detail differs per provider);
 * this owns only the shared decision so the two providers can't drift. */
export const finishWebhookVerification = (
  matched: boolean,
  payload: string,
  errorCode: ErrorCodeType,
): VerifiedWebhookPayload => {
  if (!matched) return { error: "Signature verification failed", valid: false };
  try {
    return { valid: true, value: JSON.parse(payload) };
  } catch (error) {
    // The signature matched, so this really is the provider talking and we
    // still cannot read it. Say so, or the payment goes missing in silence.
    logError({
      code: errorCode,
      detail: `invalid JSON: ${errorMessage(error)}`,
    });
    return { error: `Invalid webhook JSON (${errorCode})`, valid: false };
  }
};
