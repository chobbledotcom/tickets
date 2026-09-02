/** The source forms that name one fixed field. */

import ts from "typescript";

export type LiteralFieldName =
  | ts.StringLiteral
  | ts.NumericLiteral
  | ts.NoSubstitutionTemplateLiteral
  | NegativeNumericName;

type NegativeNumericName = ts.PrefixUnaryExpression & {
  operand: ts.NumericLiteral;
};

export const isNegativeNumericName = (
  node: ts.Node,
): node is NegativeNumericName =>
  ts.isPrefixUnaryExpression(node) &&
  node.operator === ts.SyntaxKind.MinusToken &&
  ts.isNumericLiteral(node.operand);

/** The property name that TypeScript gives one field. */
export type FieldName = ts.Identifier | LiteralFieldName;

export const isLiteralFieldName = (node: ts.Node): node is LiteralFieldName =>
  ts.isStringLiteral(node) ||
  ts.isNumericLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  isNegativeNumericName(node);

export const isFieldName = (node: ts.Node): node is FieldName =>
  ts.isIdentifier(node) || isLiteralFieldName(node);

const isDeclaredNegativeZero = (name: NegativeNumericName): boolean => {
  if (Number(name.operand.text) !== 0) return false;
  const computed = name.parent;
  if (!ts.isComputedPropertyName(computed)) return false;
  const holder = computed.parent.parent;
  return (
    ts.isInterfaceDeclaration(holder) ||
    ts.isTypeLiteralNode(holder) ||
    ts.isClassLike(holder)
  );
};

export const fieldNameText = (name: FieldName): string =>
  ts.isPrefixUnaryExpression(name)
    ? isDeclaredNegativeZero(name)
      ? "-0"
      : String(-Number(name.operand.text))
    : name.text;
