/**
 * Request-scoped access to the site's private key. The owner key pair decrypts
 * attendee PII and the activity log. To derive the private key you need the
 * authenticated session: its token unwraps the DATA_KEY, which decrypts the
 * stored private key.
 *
 * {@link getRequestPrivateKey} removes the threading a caller would otherwise
 * do: it reads the AsyncLocalStorage-scoped session for the *current request*
 * (see session-context.ts) and derives the key on demand. Because the session
 * store is bound to the current request's async context, the accessor can only
 * ever return *this* request's own session, and the derivation is keyed by that
 * session's unique token, so no path lets one request obtain another's key.
 *
 * Outside a request (background jobs, write-only webhooks, unit tests with no
 * context) there is no session, so the accessor fails closed.
 */

import { getPrivateKeyFromSession } from "#crypto/keys.ts";
import type { WrappedKey } from "#crypto/sealed.ts";
import { settings } from "#db/settings.ts";
import { namedError } from "#shared/named-error.ts";
import { getCachedSession } from "#shared/session-context.ts";

/** Minimal session shape needed to derive the private key. */
type KeyedSession = { token: string; wrappedDataKey: WrappedKey | null };

/** Thrown when the current session's private key cannot be derived (e.g.
 * wrappedDataKey missing, no key pair configured, or unwrap failure). */
export class SessionKeyError extends namedError("SessionKeyError") {
  constructor() {
    super("Private key unavailable for session");
  }
}

/**
 * Derive the private key for an explicit session, or null when it cannot be
 * derived (no wrapped data key, no stored private key, or an unwrap failure —
 * e.g. after a DB_ENCRYPTION_KEY rotation invalidates an old session).
 */
export const getSessionPrivateKey = async (
  session: KeyedSession,
): Promise<CryptoKey | null> => {
  if (!session.wrappedDataKey) return null;
  if (!settings.wrappedPrivateKey) return null;

  try {
    return await getPrivateKeyFromSession(
      session.token,
      session.wrappedDataKey,
      settings.wrappedPrivateKey,
    );
  } catch {
    return null;
  }
};

/**
 * Private key for the current request's session, or null when there is no
 * session in scope or its key cannot be derived.
 */
export const getRequestPrivateKey = (): Promise<CryptoKey | null> => {
  const session = getCachedSession();
  return session ? getSessionPrivateKey(session) : Promise.resolve(null);
};

/**
 * Private key for the current request's session, throwing {@link SessionKeyError}
 * when unavailable. Use this where decryption must succeed for the page to
 * render (the activity log, attendee PII) — the central request error handler
 * special-cases SessionKeyError into a re-authenticate response.
 */
export const requireRequestPrivateKey = async (): Promise<CryptoKey> => {
  const key = await getRequestPrivateKey();
  if (!key) throw new SessionKeyError();
  return key;
};
