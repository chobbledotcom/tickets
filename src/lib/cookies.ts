import { getAllowedDomain } from "#lib/config.ts";
import { SESSION_MAX_AGE_S } from "#lib/limits.ts";

export const isSecureMode = (): boolean => getAllowedDomain() !== "localhost";

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

/** Cookie name for flash messages (success/error after redirects) */
const FLASH_COOKIE_NAME = "flash";

/** Build a flash cookie containing a success or error message */
export const buildFlashCookie = (
  message: string,
  succeeded: boolean,
): string => {
  const type = succeeded ? "s" : "e";
  const value = encodeURIComponent(`${type}:${message}`);
  return `${FLASH_COOKIE_NAME}=${value}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=10`;
};

/** Clear the flash cookie (set after reading) */
export const clearFlashCookie = (): string =>
  `${FLASH_COOKIE_NAME}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;

/** Parse a flash cookie value into type and message, or null if invalid */
export const parseFlashValue = (
  value: string,
): { success?: string; error?: string } | null => {
  const decoded = decodeURIComponent(value);
  if (decoded.startsWith("s:")) {
    return { success: decoded.slice(2) };
  }
  if (decoded.startsWith("e:")) {
    return { error: decoded.slice(2) };
  }
  return null;
};
