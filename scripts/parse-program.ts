import { type Program, parseSync } from "npm:oxc-parser@0.132.0";

/** Parse one module and reject a recovered tree before any caller uses it. */
export const parseProgram = (file: string, source: string): Program => {
  const result = parseSync(file, source, { sourceType: "module" });
  const error = result.errors[0];
  if (error !== undefined) {
    throw new Error(`${file} does not parse: ${error.message}`);
  }
  return result.program;
};
