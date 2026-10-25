/**
 * Visit every node in one parsed program, depth-first, parents before
 * children. One mechanism behind every AST-walking check rule, so the tree
 * walks cannot drift apart.
 */

/** One node of a parsed program, read as a record. */
export type ProgramNode = Record<string, unknown>;

/** Walk every node in `tree`, visiting each object node once. */
export const walkNodes = (
  node: unknown,
  visit: (node: ProgramNode) => void,
): void => {
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as ProgramNode;
  visit(record);
  for (const value of Object.values(record)) walkNodes(value, visit);
};
