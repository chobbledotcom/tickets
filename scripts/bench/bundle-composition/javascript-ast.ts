import { parseSync } from "npm:oxc-parser@0.132.0";

const countAstNodes = (root: object): number => {
  const visited = new WeakSet<object>();
  let count = 0;
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) {
      return;
    }
    visited.add(value);
    if ("type" in value) count += 1;
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return count;
};

/** Count the syntax nodes the JavaScript parser builds for a bundle. */
export const countJavaScriptAstNodes = (source: string): number => {
  const result = parseSync("bundle.js", source, { sourceType: "module" });
  const error = result.errors[0];
  if (error) throw new Error(`Bundle JavaScript is invalid: ${error.message}`);
  return countAstNodes(result.program);
};
