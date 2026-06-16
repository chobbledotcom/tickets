import { getEffectiveDomain } from "#shared/config.ts";
import type { Flash } from "#shared/flash-context.ts";
import { SESSION_MAX_AGE_S } from "#shared/limits.ts";

export const isSecureMode = (): boolean => getEffectiveDomain() !== "localhost";

const secureAttribute = (): string => (isSecureMode() ? "; Secure" : "");

const sessionCookieName = (): string =>
  isSecureMode() ? "__Host-session" : "session";

export const getSessionCookieName = (): string => sessionCookieName();

export const buildSessionCookie = (
  token: string,
  options?: { maxAge?: number },
): string => {
  const maxAge = options?.maxAge ?? SESSION_MAX_AGE_S;
  return `${sessionCookieName()}=${token}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
};

export const clearSessionCookie = (): string =>
  `${sessionCookieName()}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;

/** Cookie name prefix for flash messages (keyed by per-request ID) */
const FLASH_COOKIE_PREFIX = "flash_";

/** Build the cookie name for a keyed flash message */
const flashCookieName = (id: string): string => `${FLASH_COOKIE_PREFIX}${id}`;

/** Visual level of a flash message: a positive result, a failure, or a
 * neutral acknowledgement. */
export type FlashLevel = "success" | "error" | "info";

/** Single-char cookie tag for each flash level. */
const FLASH_TYPE_CHAR: Record<FlashLevel, string> = {
  error: "e",
  info: "i",
  success: "s",
};

/** Build a flash cookie containing a success, error, or info message, keyed by
 * ID. `level` defaults to success/error from `succeeded`; pass it to override.
 * `formToken` redeems the in-memory form re-fill stash on the follow-up GET; it
 * rides in this HttpOnly, SameSite=Strict cookie rather than the URL so it
 * can't be guessed or leaked via history/referrer. */
export const buildFlashCookie = (
  id: string,
  message: string,
  succeeded: boolean,
  result?: string,
  level: FlashLevel = succeeded ? "success" : "error",
  formToken?: string,
): string => {
  const type = FLASH_TYPE_CHAR[level];
  // Keys are assigned in alphabetical order so the serialized JSON matches the
  // sorted object literals the tests build; parsing is order-independent.
  const obj: Record<string, string> = {};
  if (formToken) obj.f = formToken;
  obj.m = message;
  if (result) obj.r = result;
  obj.t = type;
  const value = encodeURIComponent(JSON.stringify(obj));
  return `${flashCookieName(
    id,
  )}=${value}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=10`;
};

/** Clear a keyed flash cookie (set after reading) */
export const clearFlashCookie = (id: string): string =>
  `${flashCookieName(
    id,
  )}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;

/** Parse a flash cookie value into type, message, optional result, and the
 * optional form re-fill stash token. */
export const parseFlashValue = (value: string): Flash => {
  const decoded = decodeURIComponent(value);
  const obj = JSON.parse(decoded);
  return {
    error: obj.t === "e" ? obj.m : undefined,
    formToken: obj.f,
    info: obj.t === "i" ? obj.m : undefined,
    result: obj.r,
    success: obj.t === "s" ? obj.m : undefined,
  };
};
