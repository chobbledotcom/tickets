import { getAllowedDomain } from "#lib/config.ts";

const DEFAULT_SESSION_MAX_AGE = 60 * 60 * 24;
const DEFAULT_CSRF_MAX_AGE = 60 * 60;

export const isSecureMode = (): boolean => getAllowedDomain() !== "localhost";

const cookieName = (baseName: string): string =>
  isSecureMode() ? `__Host-${baseName}` : baseName;

const secureAttribute = (): string => (isSecureMode() ? "; Secure" : "");

export const getSessionCookieName = (): string => cookieName("session");

export const buildSessionCookie = (
  token: string,
  options?: { maxAge?: number },
): string => {
  const maxAge = options?.maxAge ?? DEFAULT_SESSION_MAX_AGE;
  return `${getSessionCookieName()}=${token}; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
};

export const buildClearedSessionCookie = (): string =>
  `${getSessionCookieName()}=; HttpOnly${secureAttribute()}; SameSite=Strict; Path=/; Max-Age=0`;

export const getCsrfCookieName = (baseName: string): string => cookieName(baseName);

export const buildCsrfCookie = (
  baseName: string,
  token: string,
  options: { path: string; inIframe?: boolean; maxAge?: number },
): string => {
  const maxAge = options.maxAge ?? DEFAULT_CSRF_MAX_AGE;
  const sameSite = options.inIframe ? "None" : "Strict";
  const partitioned = options.inIframe ? "; Partitioned" : "";
  return `${getCsrfCookieName(baseName)}=${token}; HttpOnly${secureAttribute()}; SameSite=${sameSite}; Path=${options.path}; Max-Age=${maxAge}${partitioned}`;
};
