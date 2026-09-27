import { type Program, parseSync } from "npm:oxc-parser@0.132.0";
import { isRecord } from "#types";

/** Parse one module and reject a recovered tree before any caller uses it. */
export const parseProgram = (file: string, source: string): Program => {
  const result = parseSync(file, source, { sourceType: "module" });
  const error = result.errors[0];
  if (error !== undefined) {
    throw new Error(`${file} does not parse: ${error.message}`);
  }
  return result.program;
};

/** One top-level statement of a parsed module, as the parser types it. */
export type ParsedStatement = Program["body"][number];

/** Visit every node in one parsed program, depth-first, parents first. */
export const visitNodes = (
  node: unknown,
  visit: (node: Record<string, unknown>) => void,
): void => {
  if (Array.isArray(node)) {
    for (const child of node) visitNodes(child, visit);
    return;
  }
  if (!isRecord(node)) return;
  visit(node);
  for (const value of Object.values(node)) visitNodes(value, visit);
};
