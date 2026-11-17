// effects: pure
import { fieldName } from "#shared/column-names.ts";

/** The camelCase box name of one word under a prefix: `pii` and
 *  `special_instructions` give `piiSpecialInstructions`. */
export const prefixedBoxName = (prefix: string, word: string): string => {
  const name = fieldName(word);
  return `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};
