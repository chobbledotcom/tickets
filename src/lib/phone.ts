/**
 * Phone number normalization utilities
 */

/** Strip non-numeric characters from a phone number, then prefix if it starts with 0 */
export const normalizePhone = (phone: string, prefix: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("0") ? "+" + prefix + digits.slice(1) : "+" + digits;
};
