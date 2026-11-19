// effects: pure

import { fieldName } from "#shared/column-names.ts";
import { bindFirst } from "#shared/fp-bind.ts";

/** The camelCase box name of one word under a prefix: `pii` and
 *  `special_instructions` give `piiSpecialInstructions`. */
export const prefixedBoxName = (prefix: string, word: string): string => {
  const name = fieldName(word);
  return `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

/** The box name of one kind and the ids that address it. The ids follow the
 *  kind, and an underscore separates two ids: `childQty5_9`. A kind without
 *  ids is the name of its shared box. */
const idBoxName = (kind: string, ...ids: number[]): string =>
  `${kind}${ids.join("_")}`;

/** The box name builder of one kind. */
export const boxNameOfKind = bindFirst(idBoxName);
