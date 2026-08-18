import { lazyRef, range, ttlCache } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { wrapDataKeyForPassword } from "#shared/crypto/keys.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createUser,
  getUserByUsername,
  onUsersInvalidated,
} from "#shared/db/users.ts";
import type { EmailConfig } from "#shared/email.ts";
import { sendEmailOk } from "#shared/email-ok.ts";
import { getEnv } from "#shared/env.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowMs } from "#shared/now.ts";
import type { SuperuserChoice } from "#shared/types.ts";
import {
  emailLocalPart,
  parseEmail,
  type ValidEmail,
} from "#shared/validation/email.ts";
import { validateUsername } from "#templates/fields/validators.ts";

export type SuperuserState =
  | {
      available: false;
      reason: "missing-env" | "invalid-env" | "invalid-username";
    }
  | {
      available: true;
      email: ValidEmail;
      username: string;
      choice: SuperuserChoice;
      userExists: boolean;
      activated: boolean;
    };

export const getAdminEmailAddress = (): ValidEmail | null => {
  const raw = getEnv("ADMIN_EMAIL_ADDRESS");
  if (!raw?.trim()) return null;
  const email = parseEmail(raw);
  if (!email) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `ADMIN_EMAIL_ADDRESS is not a valid email: ${raw.trim()}`,
    });
    return null;
  }
  return email;
};

export const getSuperuserUsername = (email: ValidEmail): string | null => {
  const username = emailLocalPart(email).toLowerCase();
  const error = validateUsername(username);
  if (error) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `Derived superuser username "${username}" is invalid: ${error}`,
    });
    return null;
  }
  return username;
};

/** Whether the derived superuser account exists and has been activated. */
type SuperuserAccount = { userExists: boolean; activated: boolean };

/**
 * Cache of the superuser account-state lookup — the only DB-touching part of the
 * owner settings nag, recomputed on every owner page view. Keyed by the derived
 * username so a username change (tests only) gets its own entry. Cleared on any
 * user write: createUser / activateUser / deleteUser all funnel through
 * invalidateUsersCache, which fires the registered listener below. The TTL
 * matches the users cache so cross-isolate staleness is bounded identically.
 */
const SUPERUSER_ACCOUNT_TTL_MS = 15_000;
const superuserAccountCache = ttlCache<string, SuperuserAccount>(
  SUPERUSER_ACCOUNT_TTL_MS,
  nowMs,
);
// Bumped on every users-cache invalidation. A lookup that began before an
// invalidation captured the pre-write generation, so it must not write that
// now-stale result back — mirroring the keyed cache's own generation guard.
const [getCacheGeneration, setCacheGeneration] = lazyRef<number>(() => 0);
onUsersInvalidated(() => {
  superuserAccountCache.clear();
  setCacheGeneration(getCacheGeneration() + 1);
});

/** Resolve the superuser account state, serving from cache when warm. */
const getSuperuserAccount = async (
  username: string,
): Promise<SuperuserAccount> => {
  const cached = superuserAccountCache.get(username);
  if (cached) return cached;
  // Snapshot the generation before the await; if a user write invalidates the
  // cache while getUserByUsername is in flight, this result predates the write,
  // so it is handed back to this caller but never cached.
  const generation = getCacheGeneration();
  const user = await getUserByUsername(username);
  const account: SuperuserAccount = {
    activated: user !== null && user.wrapped_data_key !== null,
    userExists: user !== null,
  };
  if (generation === getCacheGeneration()) {
    superuserAccountCache.set(username, account);
  }
  return account;
};

export const getSuperuserState = async (): Promise<SuperuserState> => {
  const raw = getEnv("ADMIN_EMAIL_ADDRESS");
  const email = getAdminEmailAddress();
  if (!email) {
    return { available: false, reason: raw ? "invalid-env" : "missing-env" };
  }

  const username = getSuperuserUsername(email);
  if (!username) return { available: false, reason: "invalid-username" };

  const { userExists, activated } = await getSuperuserAccount(username);

  const choice = settings.superuserChoice;

  return {
    activated,
    available: true,
    choice,
    email,
    userExists,
    username,
  };
};

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Each draw asks for twice the characters still needed, so one is almost
 * always enough and even a dozen would be a freak run. Needing this many means
 * the randomness source is handing back nothing usable. */
const MAX_PASSWORD_DRAWS = 100;

export const generateSuperuserPassword = (length = 12): string => {
  const alphabetLength = PASSWORD_ALPHABET.length;
  const maxValidByte = 256 - (256 % alphabetLength);
  let result = "";

  for (const _draw of range(0, MAX_PASSWORD_DRAWS)) {
    // Rejection sampling: bytes past the last whole multiple of the alphabet
    // are dropped so every character stays equally likely.
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    result += Array.from(bytes)
      .filter((byte) => byte < maxValidByte)
      .slice(0, length - result.length)
      .map((byte) => PASSWORD_ALPHABET[byte % alphabetLength])
      .join("");
    if (result.length >= length) return result;
  }

  throw new Error("Could not draw enough random characters for a password");
};

export const createActivatedSuperuser = async (opts: {
  username: string;
  password: string;
  dataKey: CryptoKey;
}): Promise<ReturnType<typeof createUser>> => {
  const passwordHash = await hashPassword(opts.password);
  // v2: bind the superuser's wrapped DATA_KEY to its generated password (emailed
  // out-of-band, never stored), making this the sanctioned recovery account.
  const wrappedDataKey = await wrapDataKeyForPassword(
    opts.dataKey,
    opts.password,
    passwordHash,
  );
  return createUser(opts.username, passwordHash, wrappedDataKey, "owner");
};

/** Escape HTML special characters for safe email HTML bodies */
const escapeHtmlEmail = (text: string): string =>
  escapeHtml(text).replace(/'/g, "&#39;");

/** Send the superuser credentials email. Returns true on 2xx status. */
export const sendSuperuserCredentialsEmail = async (
  config: EmailConfig,
  opts: {
    email: ValidEmail;
    username: string;
    password: string;
  },
): Promise<boolean> => {
  const domain = getEffectiveDomain();
  return sendEmailOk(config, {
    html: `<p>A superuser account has been enabled for this ticket platform.</p>
<p>Login URL: https://${escapeHtmlEmail(domain)}/admin/</p>
<p>Username: <strong>${escapeHtmlEmail(opts.username)}</strong></p>
<p>Password: <strong>${escapeHtmlEmail(opts.password)}</strong></p>
<p>Store this password securely. This account can decrypt attendee data and invite replacement owner accounts.</p>`,
    subject: "Superuser account enabled",
    text:
      "A superuser account has been enabled for this ticket platform.\n\n" +
      `Login URL: https://${domain}/admin/\n` +
      `Username: ${opts.username}\n` +
      `Password: ${opts.password}\n\n` +
      "Store this password securely. This account can decrypt attendee data and invite replacement owner accounts.",
    to: opts.email,
  });
};
