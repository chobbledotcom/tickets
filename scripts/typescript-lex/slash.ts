/** Whether a character can begin a word. The `#` is for private names. */
export const isWordStart = (character: string): boolean =>
  /[#$_\p{ID_Start}]/u.test(character);

export const isWordPart = (character: string): boolean =>
  /(?:[$_\p{ID_Continue}]|\u200C|\u200D)/u.test(character);

/** Whether a character doubles into `++` or `--`. */
export const isStepChange = (character: string): boolean =>
  character === "+" || character === "-";

const ENDS_A_VALUE = new Set(
  ") ++ -- ] } ID NUM RE STR false null this true undefined".split(" "),
);

const HEADER_WORDS = new Set(["for", "if", "while"]);

const BLOCK_BRACE_AFTER = new Set([
  "",
  ...") ; { } => ID catch do else finally try".split(" "),
]);

const matchingOpener =
  (closes: string, opens: string) =>
  (tokens: readonly string[]): number => {
    let depth = 0;
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (token === closes) depth++;
      if (token !== opens) continue;
      depth--;
      if (depth === 0) return index;
    }
    return -1;
  };

const parenOpensAt = matchingOpener(")", "(");
const bracketOpensAt = matchingOpener("]", "[");
const braceOpensAt = matchingOpener("}", "{");

const closesAHeader = (tokens: readonly string[]): boolean => {
  const at = parenOpensAt(tokens);
  if (at === -1) return false;
  const word = tokens[at - 1] ?? "";
  if (word !== "await") return HEADER_WORDS.has(word);
  return tokens[at - 2] === "for";
};

const LABEL_PARTS = new Set([".", "ID", "NUM", "STR", "case", "default"]);

const beforeBracketed = (
  openerAt: (tokens: readonly string[]) => number,
  tokens: readonly string[],
  from: number,
): number => {
  const open = openerAt(tokens.slice(0, from + 1));
  return open === -1 ? -1 : open - 1;
};

/** Step back across one label part or one balanced group. */
const stepBackOverLabel = (
  tokens: readonly string[],
  index: number,
): number => {
  const token = tokens[index] as string;
  if (token === ")") return beforeBracketed(parenOpensAt, tokens, index);
  if (token === "]") return beforeBracketed(bracketOpensAt, tokens, index);
  return LABEL_PARTS.has(token) ? index - 1 : index;
};

/** Whether the brace at `at` opens statements rather than a value. */
const braceOpensABlock = (tokens: readonly string[], at: number): boolean => {
  const before = tokens[at - 1] ?? "";
  if (before !== ":") return BLOCK_BRACE_AFTER.has(before);
  let index = at - 2;
  let clause = false;
  while (index >= 0) {
    const stepped = stepBackOverLabel(tokens, index);
    if (stepped === index) break;
    clause = clause || tokens[index] === "case" || tokens[index] === "default";
    index = stepped;
  }
  if (clause) return true;
  const beforeLabel = tokens[index] ?? "";
  if (beforeLabel === "?" || beforeLabel === ",") return false;
  if (beforeLabel === "{") return braceOpensABlock(tokens, index);
  if (beforeLabel === "}") {
    return !braceEndedAValue(tokens.slice(0, index + 1));
  }
  return true;
};

const braceEndedAValue = (tokens: readonly string[]): boolean => {
  const at = braceOpensAt(tokens);
  return at === -1 ? true : !braceOpensABlock(tokens, at);
};

/** Words a name can also be, so a slash straight after one divides: an
 * identifier sits there, while every keyword spelling demands a name or
 * a type after it, never a pattern. `await`, `yield`, and `of` stay out —
 * each can take a pattern as its operand. */
const NAME_LIKE = new Set(
  "abstract accessor as async declare from infer is keyof module namespace out override private protected public readonly satisfies static type".split(
    " ",
  ),
);

/** Whether the final token ends a value, so a slash after it divides. */
export const endsAValue = (tokens: readonly string[]): boolean => {
  const before = tokens[tokens.length - 1] ?? "";
  if (before === ")") return !closesAHeader(tokens);
  if (before === "}") return braceEndedAValue(tokens);
  if (before === "!") return endsAValue(tokens.slice(0, -1));
  return NAME_LIKE.has(before) || ENDS_A_VALUE.has(before);
};
