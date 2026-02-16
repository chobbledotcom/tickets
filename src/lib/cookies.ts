import { getAllowedDomain } from "#lib/config.ts";

const DEFAULT_SESSION_MAX_AGE = 60 * 60 * 24;

export const isSecureMode = (): boolean => getAllowedDomain() !== "localhost";

const secureAttribute = (): string => (isSecureMode() ? "; Secure" : "");

const sessionCookieName = (): string =>
  isSecureMode() ? "__Host-session" : "session";

export const getSessionCookieName = (): string => sessionCookieName();

export const buildSessionCookie = (
  token: string,
  options?: { maxAge?: number },
): string => {
  const maxAge = options?.maxAge ?? DEFAULT_SESSION_MAX_AGE;
  return `${sessionCookieName()}=${token}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
};

export const clearSessionCookie = (): string =>
  `${sessionCookieName()}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;
