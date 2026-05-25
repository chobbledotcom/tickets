import { isValidBusinessEmail } from "#shared/business-email.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { deriveKEK, wrapKey } from "#shared/crypto/keys.ts";
import { settings } from "#shared/db/settings.ts";
import { createUser, getUserByUsername } from "#shared/db/users.ts";
import { type EmailConfig, sendEmail } from "#shared/email.ts";
import { getEnv } from "#shared/env.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { SuperuserChoice } from "#shared/types.ts";
import { validateUsername } from "#templates/fields.ts";

export type SuperuserState =
  | {
      available: false;
      reason: "missing-env" | "invalid-env" | "invalid-username";
    }
  | {
      available: true;
      email: string;
      username: string;
      choice: SuperuserChoice;
      userExists: boolean;
      activated: boolean;
    };

export const getAdminEmailAddress = (): string | null => {
  const raw = getEnv("ADMIN_EMAIL_ADDRESS");
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (!isValidBusinessEmail(trimmed)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `ADMIN_EMAIL_ADDRESS is not a valid email: ${trimmed}`,
    });
    return null;
  }
  return trimmed;
};

export const getSuperuserUsername = (email: string): string | null => {
  const localPart = email.split("@")[0]!;
  const username = localPart.toLowerCase();
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

export const getSuperuserState = async (): Promise<SuperuserState> => {
  const raw = getEnv("ADMIN_EMAIL_ADDRESS");
  const email = getAdminEmailAddress();
  if (!email) {
    return { available: false, reason: raw ? "invalid-env" : "missing-env" };
  }

  const username = getSuperuserUsername(email);
  if (!username) return { available: false, reason: "invalid-username" };

  const user = await getUserByUsername(username);
  const userExists = user !== null;
  const activated = userExists && user.wrapped_data_key !== null;

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

export const generateSuperuserPassword = (length = 12): string => {
  const alphabetLength = PASSWORD_ALPHABET.length;
  const maxValidByte = 256 - (256 % alphabetLength);
  let result = "";
  let count = 0;

  while (count < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (let i = 0; i < bytes.length && count < length; i++) {
      const byte = bytes[i]!;
      if (byte < maxValidByte) {
        result += PASSWORD_ALPHABET[byte % alphabetLength];
        count++;
      }
    }
  }

  return result;
};

export const createActivatedSuperuser = async (opts: {
  username: string;
  password: string;
  dataKey: CryptoKey;
}): Promise<ReturnType<typeof createUser>> => {
  const passwordHash = await hashPassword(opts.password);
  const kek = await deriveKEK(passwordHash);
  const wrappedDataKey = await wrapKey(opts.dataKey, kek);
  return createUser(opts.username, passwordHash, wrappedDataKey, "owner");
};

/** Escape HTML special characters for safe email HTML bodies */
const escapeHtmlEmail = (text: string): string =>
  escapeHtml(text).replace(/'/g, "&#39;");

/** Send the superuser credentials email. Returns true on 2xx status. */
export const sendSuperuserCredentialsEmail = async (
  config: EmailConfig,
  opts: {
    email: string;
    username: string;
    password: string;
  },
): Promise<boolean> => {
  const domain = getEffectiveDomain();
  const status = await sendEmail(config, {
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
  return status !== undefined && status >= 200 && status < 300;
};
