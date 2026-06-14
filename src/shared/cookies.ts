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
 * ID. `level` defaults to success/error from `succeeded`; pass it to override. */
export const buildFlashCookie = (
  id: string,
  message: string,
  succeeded: boolean,
  result?: string,
  level: FlashLevel = succeeded ? "success" : "error",
): string => {
  const type = FLASH_TYPE_CHAR[level];
  const payload = JSON.stringify(
    result ? { m: message, r: result, t: type } : { m: message, t: type },
  );
  const value = encodeURIComponent(payload);
  return `${flashCookieName(
    id,
  )}=${value}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=10`;
};

/** Clear a keyed flash cookie (set after reading) */
export const clearFlashCookie = (id: string): string =>
  `${flashCookieName(
    id,
  )}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;

/** Parse a flash cookie value into type, message, and optional result */
export const parseFlashValue = (value: string): Flash => {
  const decoded = decodeURIComponent(value);
  const obj = JSON.parse(decoded);
  return {
    error: obj.t === "e" ? obj.m : undefined,
    info: obj.t === "i" ? obj.m : undefined,
    result: obj.r,
    success: obj.t === "s" ? obj.m : undefined,
  };
};
