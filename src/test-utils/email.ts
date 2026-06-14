import { parseEmail, type ValidEmail } from "#shared/business-email.ts";

/**
 * Brand a known-valid address as ValidEmail for tests. Throws when the literal
 * is not actually valid, so a typo in a fixture surfaces immediately rather than
 * silently producing a bad value.
 */
export const validEmail = (address: string): ValidEmail => {
  const parsed = parseEmail(address);
  if (!parsed) throw new Error(`Test fixture is not a valid email: ${address}`);
  return parsed;
};
