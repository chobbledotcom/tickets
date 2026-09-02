import { map } from "#fp";
import { parseProgram } from "#scripts/parse-program.ts";

const countAstNodes = (root: object): number => {
  let count = 0;
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if ("type" in value) count += 1;
    map(visit)(Object.values(value));
  };
  visit(root);
  return count;
};

/** Count the syntax nodes the JavaScript parser builds for a bundle. */
export const countJavaScriptAstNodes = (source: string): number =>
  countAstNodes(parseProgram("bundle.js", source));
