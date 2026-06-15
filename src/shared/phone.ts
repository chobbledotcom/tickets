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

/** A clickable phone number's `tel:` and WhatsApp (`wa.me`) hrefs. */
export type PhoneLinks = { tel: string; whatsapp: string };

/**
 * Build `tel:` and `wa.me` hrefs for a phone number, or null when the number
 * has no digits. The prefix is the country dialling code (e.g. "44"); a
 * leading "+" is tolerated so a settings value of either "44" or "+44" works.
 * WhatsApp's wa.me wants the international number with no leading "+".
 */
export const phoneLinks = (
  phone: string,
  prefix: string,
): PhoneLinks | null => {
  const normalized = normalizePhone(phone, prefix.replace(/^\+/, ""));
  if (!normalized) return null;
  return {
    tel: `tel:${normalized}`,
    // normalized always starts with "+", which wa.me must not include.
    whatsapp: `https://wa.me/${normalized.slice(1)}`,
  };
};
