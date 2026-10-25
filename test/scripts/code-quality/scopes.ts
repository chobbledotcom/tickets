/**
 * The block scopes two numbered-bind rules share: the matched brace pairs of
 * one file, and the one declaration of a name that a use at a position can
 * reach. The repeated-bind rule resolves an args name to its array; the
 * numbered-token rule resolves a statement constant to its declaration.
 */

/** One matched `{`…`}` pair of the blanked text. Strings, comments, and
 * regular expressions arrive pre-blanked, so no phantom brace pairs. */
export type Block = { close: number; open: number };

/** Every matched brace pair of one file, in source order. */
export const matchedBlocks = (blanked: string): Block[] => {
  const blocks: Block[] = [];
  const opens: number[] = [];
  for (let at = 0; at < blanked.length; at++) {
    if (blanked[at] === "{") opens.push(at);
    if (blanked[at] === "}") {
      const open = opens.pop();
      if (open !== undefined) blocks.push({ close: at, open });
    }
  }
  return blocks;
};

/** The innermost block that holds `at`, or undefined for the file itself.
 * Blocks arrive in the order their `}` closes, so the innermost block that
 * holds a position is the first one that holds it. */
export const innermostBlockAt = (
  blocks: Block[],
  at: number,
): Block | undefined =>
  blocks.find((block) => block.open < at && at < block.close);

/** The one declaration of a name that reaches a use at `at`: the innermost
 * scope that declares the name wins, and inside it the declaration that
 * precedes the use. A declaration in an unrelated scope never reaches the
 * use, and a same-scope declaration after the use shadows it to nothing. */
export const visibleDeclaration = <Declaration extends { start: number }>(
  blocks: Block[],
  declarations: readonly Declaration[] | undefined,
  at: number,
): Declaration | undefined => {
  if (declarations === undefined) return;
  const scopes = [
    ...blocks
      .filter((block) => block.open < at && at < block.close)
      .sort((one, other) => other.open - one.open),
    undefined,
  ];
  for (const scope of scopes) {
    const inScope = declarations.filter(
      (declaration) => innermostBlockAt(blocks, declaration.start) === scope,
    );
    if (inScope.length > 0) {
      return inScope.filter((declaration) => declaration.start < at).at(-1);
    }
  }
  return;
};
