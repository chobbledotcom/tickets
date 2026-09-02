/**
 * Which parts of a shape the walk goes into, and which hold nothing the
 * shape hands out. Kept apart from the steps themselves because the two
 * answer different questions: what to enter, and how to name what it holds.
 */

import ts from "typescript";
import { filter } from "#fp";
import {
  holdsElements,
  holdsKeysAndValues,
  passesMembersThrough,
} from "./steps.ts";

/** Whether a generic hands its argument on where the walk can see it. The
 * walk's own containers take their argument as the thing they hold, and the
 * pass-through utilities — the built-in `Partial`, `Required` and
 * `Readonly`, resolved through the checker so a borrowed name is not
 * mistaken for them — keep its members. Every other generic puts its
 * argument somewhere of its own, so only the checker knows where it lives. */
const keepsItsArgumentVisible =
  (checker: ts.TypeChecker): ((node: ts.TypeReferenceNode) => boolean) =>
  (node) =>
    holdsElements(checker)(node) ||
    holdsKeysAndValues(checker)(node) ||
    passesMembersThrough(checker)(node);

/** `keyof Row` names the words a shape's fields are called, not the fields. */
const isKeyOf = (node: ts.Node): boolean =>
  ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword;

/** The two ways to write a type none of whose syntax parts is the answer —
 * `keyof` names the words rather than the fields, and `Row["paid"]` picks
 * one key out of another type. A reference to a filter such as `Extract` or
 * `Omit` is the third way, and the generic rule below carries it: no value
 * of the answer holds what the filter's own arguments wrote down, so only
 * the checker knows what is left. */
const holdsNoAnswer = (node: ts.Node): boolean =>
  isKeyOf(node) || ts.isIndexedAccessTypeNode(node);

/** The one arm a conditional answers with, when it has an answer. `true
 * extends true ? A : B` is only ever A, so no value of it holds a field of B.
 * A conditional that waits on a type parameter has no answer yet, and both
 * arms stay possible. A conditional that answers through a substituted `infer`
 * variable names its answer in neither arm — the true arm still denotes the
 * variable, and the checker hands back the substituted type — so the answer
 * is not a node to walk at all, and the checker path through the resolved
 * type is what carries the members. A union the answer names is the union
 * itself: an arm written as that union equals it, so the walk takes it and
 * only it. A distributed answer names neither arm so exactly, and the
 * checker path carries its members instead. */
const answeredWith = (
  checker: ts.TypeChecker,
  node: ts.ConditionalTypeNode,
): ts.TypeNode | "resolved" | undefined => {
  const whole = checker.getTypeFromTypeNode(node);
  if (whole.flags & ts.TypeFlags.Conditional) return;
  const arms = [node.trueType, node.falseType];
  return (
    arms.find((arm) => checker.getTypeFromTypeNode(arm) === whole) ?? "resolved"
  );
};

/** A node that holds a body and nothing a shape hands out. A static block is
 * one: it runs when the class is made, and the locals inside it are nobody
 * else's to reach. */
const holdsOnlyCode = (node: ts.Node): boolean =>
  ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);

/** The parts of a generic the walk goes on through. A generic that hides its
 * argument keeps its own parts only, so the checker path carries the
 * argument's fields instead. */
const partsOfTheGeneric = (
  node: ts.TypeReferenceNode,
): ((part: ts.Node) => boolean) => {
  const argumentNodes = node.typeArguments ?? ([] as readonly ts.Node[]);
  return (part) => !argumentNodes.includes(part);
};

/** The parts a conditional holds. Only the answer is part of the shape; both
 * arms stay possible while the conditional waits. */
const partsOfTheConditional = (
  checker: ts.TypeChecker,
  node: ts.ConditionalTypeNode,
): ((part: ts.Node) => boolean) => {
  const answer = answeredWith(checker, node);
  if (answer === "resolved") return () => false;
  if (answer) return (part) => part === answer;
  return (part) => part !== node.checkType && part !== node.extendsType;
};

/** Which of a node's parts can hold a member. A conditional checks one type
 * against another, and only the answer is part of the shape. A function keeps
 * its parameters and the type it hands back. Its body holds a type that never
 * leaves it, and its type parameters describe themselves, exactly as a
 * shape's own ones do. A generic that puts its argument under a named member —
 * `Box<T> = { value: T }` — leaves the argument to the checker path. */
const worthWalking =
  (checker: ts.TypeChecker) =>
  (node: ts.Node): ((part: ts.Node) => boolean) => {
    // `keyof { paid: number }` is the one word "paid", not a shape with a
    // field, so nothing under it is a field either. `readonly` is a type
    // operator too, and `readonly { paid: number }[]` does hand `paid` out.
    if (holdsNoAnswer(node)) return () => false;
    if (ts.isConditionalTypeNode(node)) {
      return partsOfTheConditional(checker, node);
    }
    if (
      ts.isTypeReferenceNode(node) &&
      !keepsItsArgumentVisible(checker)(node)
    ) {
      return partsOfTheGeneric(node);
    }
    if (!holdsOnlyCode(node)) return () => true;
    return (part) => ts.isTypeNode(part) || ts.isParameter(part);
  };

/** The parts of a node the walk goes on through. */
export const membersOf =
  (checker: ts.TypeChecker): ((node: ts.Node) => ts.Node[]) =>
  (node: ts.Node): ts.Node[] => {
    const parts: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      parts.push(child);
    });
    return filter(worthWalking(checker)(node))(parts);
  };
