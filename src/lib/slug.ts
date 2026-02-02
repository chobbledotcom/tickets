/**
 * Slug utilities for URL-friendly identifiers
 *
 * Slugs are auto-generated 5-character strings from the alphabet
 * 0123456789abcdefgh (18 chars). Each slug must contain at least
 * 2 digits and 2 letters, giving ~1.15M possible combinations.
 */

const DIGITS = "0123456789";
const LETTERS = "abcdefgh";
const ALPHABET = DIGITS + LETTERS;

/** Pick a random character from a string */
const randomChar = (chars: string): string =>
  chars[Math.floor(Math.random() * chars.length)]!;

/**
 * Generate a random slug with at least 2 digits and 2 letters.
 * Uses Fisher-Yates shuffle on the fixed positions to avoid bias.
 */
export const generateSlug = (): string => {
  // Start with guaranteed minimums
  const chars: string[] = [
    randomChar(DIGITS),
    randomChar(DIGITS),
    randomChar(LETTERS),
    randomChar(LETTERS),
    randomChar(ALPHABET),
  ];

  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
};
