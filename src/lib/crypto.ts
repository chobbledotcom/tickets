/**
 * Crypto utilities that work in browser/edge environments
 * These avoid Node.js-specific APIs for Bunny Edge Script compatibility
 */

/**
 * Constant-time string comparison to prevent timing attacks
 * Compares all characters regardless of where first mismatch occurs
 *
 * Algorithm: XOR each char pair (equal=0, different=non-zero),
 * OR results together, check final result is 0.
 * Always iterates all characters - no early exit.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
};

/**
 * Generate a cryptographically secure random token
 * Uses Web Crypto API which is available in edge environments
 */
export const generateSecureToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  // Convert to base64url encoding
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
};
