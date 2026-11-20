import type { Node } from "npm:oxc-parser@0.132.0";
import { lineColumnAt } from "#scripts/line-column.ts";
import { type ParsedStatement, parseProgram } from "#scripts/parse-program.ts";

/** One top-level TypeScript declaration that a walkthrough can show. */
export type SourceDefinition = {
  readonly path: string;
  readonly symbol: string;
  readonly line: number;
  readonly text: string;
  readonly signature: string;
};

type Declaration = {
  readonly node: Node;
  readonly start: number;
  readonly end: number;
};

type NamedExport = Extract<ParsedStatement, { type: "ExportNamedDeclaration" }>;

const MAX_SIGNATURE_LINES = 24;

const declarationNames = (node: Node): string[] => {
  if (node.type === "VariableDeclaration") {
    const names: string[] = [];
    for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier") {
        names.push(declaration.id.name);
      }
    }
    return names;
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "ClassDeclaration" ||
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSTypeAliasDeclaration" ||
    node.type === "TSEnumDeclaration"
  ) {
    return node.id === null ? [] : [node.id.name];
  }
  return [];
};

const addDeclaration = (
  declarations: Map<string, Declaration>,
  node: Node,
  start: number,
  end: number,
): void => {
  for (const name of declarationNames(node)) {
    if (declarations.has(name)) {
      throw new Error(`The source declares ${name} more than once.`);
    }
    declarations.set(name, { end, node, start });
  }
};

/** The start of a block comment that sits directly above a declaration. */
const docStart = (content: string, start: number): number => {
  let cursor = start;
  while (cursor > 0 && /\s/.test(content[cursor - 1]!)) cursor--;
  if (!content.slice(0, cursor).endsWith("*/")) return start;
  return content.lastIndexOf("/*", cursor - 2);
};

const arrowCut = (
  node: Extract<Node, { type: "VariableDeclaration" }>,
): { readonly cut: number; readonly suffix: string } | null => {
  const only = node.declarations.length === 1 ? node.declarations[0] : null;
  if (only?.init?.type !== "ArrowFunctionExpression") return null;
  return {
    cut: only.init.body.start,
    suffix: only.init.body.type === "BlockStatement" ? " { ... }" : " ...",
  };
};

/** The visible part of a declaration. A long body is clipped, but its
 *  fingerprint still covers every character. */
const signatureOf = (content: string, declaration: Declaration): string => {
  const { node } = declaration;
  let cut = declaration.end;
  let suffix = "";
  const body =
    node.type === "FunctionDeclaration" && node.body !== null
      ? node.body
      : node.type === "ClassDeclaration"
        ? node.body
        : null;
  if (body !== null) {
    cut = body.start;
    suffix = " { ... }";
  } else if (node.type === "VariableDeclaration") {
    const arrow = arrowCut(node);
    if (arrow !== null) {
      cut = arrow.cut;
      suffix = arrow.suffix;
    }
  }
  const visible = content.slice(declaration.start, cut).trimEnd();
  const text = `${visible}${suffix}`;
  const lines = text.split("\n");
  if (lines.length <= MAX_SIGNATURE_LINES) return text;
  return `${lines.slice(0, MAX_SIGNATURE_LINES).join("\n")}\n// ...`;
};

/** Read one top-level declaration, with the doc comment directly above it.
 *  The symbol must be visible at the top level of this module. */
export const readSourceDefinition = (
  path: string,
  content: string,
  symbol: string,
  detail: "signature" | "declaration" = "signature",
): SourceDefinition => {
  const program = parseProgram(path, content);
  const declarations = new Map<string, Declaration>();
  const aliases = new Map<string, string>();
  const context = { aliases, declarations };
  for (const statement of program.body) {
    readStatement(context, statement);
  }
  const alias = aliases.get(symbol);
  const found = declarations.get(alias ?? symbol);
  if (found === undefined) {
    throw new Error(`${path} has no top-level declaration named ${symbol}.`);
  }
  const start = docStart(content, found.start);
  const text = content.slice(start, found.end).trimEnd();
  return {
    line: lineColumnAt(content, found.start).line,
    path,
    signature: detail === "declaration" ? text : signatureOf(content, found),
    symbol,
    text,
  };
};

const exportedName = (node: {
  readonly type: "Identifier" | "Literal";
  readonly name?: string;
  readonly value?: string;
}): string => (node.type === "Identifier" ? node.name! : String(node.value));

type ReadContext = {
  readonly declarations: Map<string, Declaration>;
  readonly aliases: Map<string, string>;
};

const addExportedDeclaration = (
  declarations: Map<string, Declaration>,
  statement: ParsedStatement,
  declaration: Node,
): void => {
  addDeclaration(declarations, declaration, statement.start, statement.end);
};

const readNamedExport = (
  context: ReadContext,
  statement: NamedExport,
): void => {
  if (statement.declaration !== null) {
    addExportedDeclaration(
      context.declarations,
      statement,
      statement.declaration,
    );
  }
  for (const specifier of statement.specifiers) {
    if (statement.source !== null) continue;
    context.aliases.set(
      exportedName(specifier.exported),
      exportedName(specifier.local),
    );
  }
};

const readDefaultExport = (
  declarations: Map<string, Declaration>,
  statement: Extract<ParsedStatement, { type: "ExportDefaultDeclaration" }>,
): void => {
  addExportedDeclaration(declarations, statement, statement.declaration);
  declarations.set("default", {
    end: statement.end,
    node: statement.declaration,
    start: statement.start,
  });
};

const readStatement = (
  context: ReadContext,
  statement: ParsedStatement,
): void => {
  if (statement.type === "ExportNamedDeclaration") {
    readNamedExport(context, statement);
    return;
  }
  if (statement.type === "ExportDefaultDeclaration") {
    readDefaultExport(context.declarations, statement);
    return;
  }
  addDeclaration(
    context.declarations,
    statement,
    statement.start,
    statement.end,
  );
};
