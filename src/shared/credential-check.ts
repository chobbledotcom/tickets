// effects: pure
/** What a connection test says about one stored provider credential. */

import { errorMessage } from "#shared/error-message.ts";

/** The check for one credential: valid, with the estate it points at when the
 * provider names one, or why not. */
export type CredentialCheck = {
  valid: boolean;
  error?: string;
  mode?: string;
};

/** The check that a refused provider call leaves: the error in plain words,
 * and no valid credential. Every provider's connection test reports a refusal
 * this way. */
export const refusedCredential = (error: unknown): CredentialCheck => ({
  error: errorMessage(error),
  valid: false,
});
