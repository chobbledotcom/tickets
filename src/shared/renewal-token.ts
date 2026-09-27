import { hmacHash } from "#crypto/hashing.ts";
import { generateSecureToken } from "#crypto/utils.ts";

/** The renewal token and its HMAC blind index. */
export type RenewalTokenData = { token: string; index: string };

/** Generate a renewal token + its HMAC blind index. */
export const generateRenewalToken = async (): Promise<RenewalTokenData> => {
  const token = generateSecureToken();
  const index = await hmacHash(token);
  return { index, token };
};
