import { hmacHash } from "#shared/crypto/hashing.ts";
import { base64ToBase64Url, constantTimeEqual } from "#shared/crypto/utils.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";

const PREFIX = "refund-cases:1:";

/** Make the owner queue's keyset boundary opaque and tamper-evident. */
export const writeProviderRefundCursor = async (
  id: number,
): Promise<string> => {
  if (!isPositiveSafeInteger(id)) {
    throw new Error("Refund-case cursor id must be a positive safe integer");
  }
  const value = String(id);
  return `${value}.${base64ToBase64Url(await hmacHash(PREFIX + value))}`;
};

/** Read one canonical cursor, or null when user input was changed/malformed. */
export const readProviderRefundCursor = async (
  cursor: string,
): Promise<number | null> => {
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (match === null) return null;
  const rawId = match[1]!;
  const signature = match[2]!;
  const id = Number(rawId);
  if (!isPositiveSafeInteger(id) || String(id) !== rawId) return null;
  const expected = base64ToBase64Url(await hmacHash(PREFIX + rawId));
  return constantTimeEqual(expected, signature) ? id : null;
};
