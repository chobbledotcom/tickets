/**
 * The syntax words both duplication gates keep as themselves: JavaScript's and
 * TypeScript's reserved words, plus its literal words. A rename never touches
 * one, so both the shape check and the rename-blind copy scan let these words
 * keep their own token while every chosen name is masked.
 *
 * `check-shapes` reaches a word here only as a genuine keyword, because the
 * parser masked every identifier first. `cpd-renamed` walks raw text, so it
 * keeps a word only in keyword position (see its own member-name rule).
 */

/** Sorted alphabetically; keep it that way. */
export const SYNTAX_WORDS = new Set([
  "abstract",
  "accessor",
  "as",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "module",
  "namespace",
  "new",
  "null",
  "of",
  "out",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);
