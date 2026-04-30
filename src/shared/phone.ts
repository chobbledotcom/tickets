/**
 * Phone number normalization utilities
 */

/** Strip non-numeric characters from a phone number and normalize to +{prefix}{local} */
export const normalizePhone = (phone: string, prefix: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";

  // Local number with leading zero: 0161... → +44161...
  if (digits.startsWith("0")) return `+${prefix}${digits.slice(1)}`;

  // Country code followed by spurious zero: 440161... → +44161...
  if (digits.startsWith(`${prefix}0`)) {
    return `+${prefix}${digits.slice(prefix.length + 1)}`;
  }

  // Already has country code without leading zero: 44161... → +44161...
  return `+${digits}`;
};
