/** Sessions that are still live when the test reads them, the way the admin's
 *  other browsers hold one. A suite that lists or clears another session fills
 *  them here, so every caller writes the same expiry and CSRF pairing. */

import { createSession } from "#db/sessions.ts";

/** One live session per token, each owned by user 1 (the test admin) and
 *  expiring a minute from now. */
export const createLiveSessions = async (
  tokens: readonly string[],
): Promise<void> => {
  for (const token of tokens) {
    await createSession(token, `${token}-csrf`, Date.now() + 60_000, null, 1);
  }
};
