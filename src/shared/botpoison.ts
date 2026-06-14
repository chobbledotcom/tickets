/**
 * Botpoison spam-protection verification.
 *
 * The browser solves a proof-of-work challenge (via the bundled
 * @botpoison/browser widget) and submits the resulting solution in a
 * `_botpoison` form field. This module verifies that solution server-side
 * against the Botpoison API using the secret key, so the secret key never
 * reaches the browser.
 */

import { getBotpoisonSecretKey } from "#shared/config.ts";
import { fetchText } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/** Botpoison verification endpoint */
const BOTPOISON_VERIFY_URL = "https://api.botpoison.com/verify";

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
    const { ok, status, text } = await fetchText(BOTPOISON_VERIFY_URL, {
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
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};
