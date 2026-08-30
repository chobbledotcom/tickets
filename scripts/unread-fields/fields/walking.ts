/**
 * Which parts of a shape the walk goes into, and which hold nothing the
 * shape hands out. Kept apart from the steps themselves because the two
 * answer different questions: what to enter, and how to name what it holds.
 */

import ts from "typescript";
import { filter } from "#fp";
import { namedOneOf } from "./steps.ts";

/** Four built-in types that keep some of the first argument and drop the
 * rest. `Extract` and `Exclude` choose arms of a union; `Pick` and `Omit`
 * choose keys of an object. Neither argument of any of them is the answer:
 * the second says what to keep and is nobody's to read, and the first still
 * holds what was dropped. Only the checker knows what is left, and it
 * resolves the reference for the shape it belongs to. Every other type
 * argument holds a type the shape hands on, as `Array<{ id: number }>` does. */
const NARROWS_BY_A_FILTER = new Set(["Extract", "Exclude", "Pick", "Omit"]);

const narrowsByAFilter = namedOneOf(NARROWS_BY_A_FILTER);

/** `keyof Row` names the words a shape's fields are called, not the fields. */
const isKeyOf = (node: ts.Node): boolean =>
  ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword;

/** Three ways to write a type none of whose parts is the answer. A filter
 * keeps some of its first argument, `keyof` names the words rather than the
 * fields, and `Row["paid"]` picks one key out of another type. The checker
 * knows what is left in each, and it answers for the shape that holds the
 * reference. */
const holdsNoAnswer = (node: ts.Node): boolean =>
  narrowsByAFilter(node) || isKeyOf(node) || ts.isIndexedAccessTypeNode(node);

/** The one arm a conditional answers with, when it has an answer. `true
 * extends true ? A : B` is only ever A, so no value of it holds a field of B.
 * A conditional that waits on a type parameter has no answer yet, and both
 * arms stay possible. A conditional that answers by substituting an `infer`
 * variable names its answer in neither arm — the true arm still denotes the
 * variable, and the checker hands back the substituted type — so the answer
 * is not a node to walk at all, and the checker path through the resolved
 * type is what carries the members. A conditional that distributes over a
 * union waits and answers at once, so its arms stay possible too. */
const answeredWith = (
  checker: ts.TypeChecker,
  node: ts.ConditionalTypeNode,
): ts.TypeNode | "resolved" | undefined => {
  const whole = checker.getTypeFromTypeNode(node);
  if (whole.flags & (ts.TypeFlags.Conditional | ts.TypeFlags.Union)) return;
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

/** Which of a node's parts can hold a member. A conditional checks one type
 * against another, and only the answer is part of the shape. A function keeps
 * its parameters and the type it hands back. Its body holds a type that never
 * leaves it, and its type parameters describe themselves, exactly as a
 * shape's own ones do. */
const worthWalking =
  (checker: ts.TypeChecker) =>
  (node: ts.Node): ((part: ts.Node) => boolean) => {
    // `keyof { paid: number }` is the one word "paid", not a shape with a
    // field, so nothing under it is a field either. `readonly` is a type
    // operator too, and `readonly { paid: number }[]` does hand `paid` out.
    if (holdsNoAnswer(node)) return () => false;
    if (ts.isConditionalTypeNode(node)) {
      const answer = answeredWith(checker, node);
      if (answer === "resolved") return () => false;
      if (answer) return (part) => part === answer;
      return (part) => part !== node.checkType && part !== node.extendsType;
    }
    if (!holdsOnlyCode(node)) return () => true;
    return (part) => ts.isTypeNode(part) || ts.isParameter(part);
  };

/** The parts of a node the walk goes on through. */
export const membersOf =
  (checker: ts.TypeChecker) =>
  (node: ts.Node): ts.Node[] => {
    const parts: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      parts.push(child);
    });
    return filter(worthWalking(checker)(node))(parts);
  };
