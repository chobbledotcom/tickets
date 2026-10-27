/**
 * Botpoison spam-protection verification.
 *
 * The browser solves a proof-of-work challenge (via the bundled
 * @botpoison/browser widget) and submits the resulting solution in a
 * `_botpoison` form field. This module verifies that solution server-side
 * against the Botpoison API using the secret key, so the secret key never
 * reaches the browser.
 */

import { defineApiClient } from "#shared/api-client.ts";
import { getBotpoisonSecretKey } from "#shared/config.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/** Botpoison verification endpoint */
const BOTPOISON_VERIFY_URL = "https://api.botpoison.com/verify";

/** The shared Botpoison client. Its one call carries no auth header — the
 * secret travels in the JSON body — so the client only owns the URL join. */
const botpoisonClient = defineApiClient({
  baseUrl: BOTPOISON_VERIFY_URL,
  headers: () => ({}),
});

/** Hidden form field populated by the browser widget with the solved challenge */
export const BOTPOISON_FIELD = "_botpoison";

/**
 * Verify a Botpoison solution against the API using the secret key.
 *
 * Returns true only when the API confirms the solution (`{ ok: true }`).
 * An empty solution, a network failure, a non-OK HTTP status, or a falsy
 * `ok` field all return false — callers treat false as "do not deliver".
 */
export const verifyBotpoisonSolution = async (
  solution: string,
): Promise<boolean> => {
  if (!solution) return false;

  const secretKey = getBotpoisonSecretKey();
  if (!secretKey) return false;

  try {
    const { ok, status, text } = await botpoisonClient.raw("", {
      body: JSON.stringify({ secretKey, solution }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!ok) {
      logError({
        code: ErrorCode.BOTPOISON_VERIFY,
        detail: `status=${status}`,
      });
      return false;
    }
    const data = JSON.parse(text) as { ok?: boolean };
    return data.ok === true;
  } catch (error) {
    logError({
      code: ErrorCode.BOTPOISON_VERIFY,
      detail: errorMessage(error),
    });
    return false;
  }
};
