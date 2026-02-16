<<<<<<< Updated upstream
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
=======
/**
 * Unified cookie policy module
 * Centralizes all cookie creation logic with security-aware defaults
 */

import { getAllowedDomain } from "#lib/config.ts";

/**
 * Determine if we're in secure mode (HTTPS + production domain)
 */
export const isSecureMode = (): boolean => {
  const domain = getAllowedDomain();
  return domain !== "localhost";
};

/**
 * Get the correct cookie name for session cookies
 * In secure mode: __Host-session
 * In dev mode: session
 */
export const getSessionCookieName = (): string => {
  return isSecureMode() ? "__Host-session" : "session";
};

/**
 * Get the correct cookie name for a CSRF cookie
 * In secure mode: __Host-{baseName}
 * In dev mode: {baseName}
 */
export const getCsrfCookieName = (baseName: string): string => {
  return isSecureMode() ? `__Host-${baseName}` : baseName;
};

/**
 * Create a session cookie with 24h expiry
 */
export const buildSessionCookie = (
  token: string,
  options: { maxAge?: number } = {},
): string => {
  const isSecure = isSecureMode();
  const maxAge = options.maxAge ?? 86400;
  return [
    `${getSessionCookieName()}=${token}`,
    "HttpOnly",
    isSecure && "Secure",
    "SameSite=Strict",
    `Path=/`,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
};

/**
 * Create an expired session cookie for logout
 */
export const buildClearedSessionCookie = (): string => {
  const isSecure = isSecureMode();
  return [
    `${getSessionCookieName()}=;`,
    "HttpOnly",
    isSecure && "Secure",
    "SameSite=Strict",
    `Path=/`,
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
};

/**
 * Create a CSRF cookie
 * Uses SameSite=Strict by default, SameSite=None + Partitioned when embedded in iframe
 */
export const buildCsrfCookie = (
  baseName: string,
  token: string,
  options: {
    path: string;
    inIframe?: boolean;
    maxAge?: number;
  },
): string => {
  const isSecure = isSecureMode();
  const isIframe = options.inIframe ?? false;
  const name = getCsrfCookieName(baseName);
  return [
    `${name}=${token}`,
    "HttpOnly",
    isSecure && "Secure",
    isIframe ? "SameSite=None" : "SameSite=Strict",
    `Path=${options.path}`,
    options.maxAge && `Max-Age=${options.maxAge}`,
    isIframe && "Partitioned",
  ]
    .filter(Boolean)
    .join("; ");
>>>>>>> Stashed changes
};
