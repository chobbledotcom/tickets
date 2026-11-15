/** Each row is one way a writer could hold a hidden payment value that the
 *  table must refuse: the text in the open, under the database owner's key,
 *  behind an upper-case envelope, or behind an envelope with nothing in it.
 *  The payment tables hide their columns behind the owner's key, so every
 *  writer path turns away the same shapes. */
export const HIDDEN_VALUE_SHAPES = [
  ["in plain words", "Jane Smith"],
  ["under the database owner's key", "enc:1:a:b"],
  ["behind an upper-case envelope", "HYB:1:a:b:c"],
  ["wearing an envelope with nothing in it", "hyb:1:Jane Smith"],
] as const;
