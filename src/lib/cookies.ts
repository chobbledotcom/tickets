import { getAllowedDomain } from "#lib/config.ts";

const DEFAULT_SESSION_MAX_AGE = 60 * 60 * 24;
const DEFAULT_CSRF_MAX_AGE = 60 * 60;

export const isSecureMode = (): boolean => getAllowedDomain() !== "localhost";

const secureAttribute = (): string => (isSecureMode() ? "; Secure" : "");

const sessionCookieName = (): string =>
  isSecureMode() ? "__Host-session" : "session";

const csrfCookieName = (baseName: string): string =>
  isSecureMode() ? `__Secure-${baseName}` : baseName;

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

export const getCsrfCookieName = (baseName: string): string => csrfCookieName(baseName);

export const buildCsrfCookie = (
  baseName: string,
  token: string,
  options: { path: string; inIframe?: boolean; maxAge?: number },
): string => {
  const maxAge = options.maxAge ?? DEFAULT_CSRF_MAX_AGE;
  const sameSite = options.inIframe ? "None" : "Strict";
  const partitioned = options.inIframe ? "; Partitioned" : "";
  return `${csrfCookieName(baseName)}=${token}; HttpOnly${secureAttribute()}; SameSite=${sameSite}; Path=${options.path}; Max-Age=${maxAge}${partitioned}`;
};
