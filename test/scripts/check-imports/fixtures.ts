import { type Alias, findImportIssues } from "#scripts/check-imports/rules.ts";

export const ALIASES: Alias[] = [
  { name: "#db/", target: "./src/shared/db/" },
  { name: "#jsx/jsx-runtime", target: "./src/shared/jsx/jsx-runtime.ts" },
  { name: "#shared/", target: "./src/shared/" },
  { name: "#src/", target: "./src/" },
  { name: "#types", target: "./src/shared/types.ts" },
];

export const messages = (
  source: string,
  aliases: Alias[] = ALIASES,
): string[] =>
  findImportIssues("sample.ts", source, aliases).map((issue) => issue.message);
