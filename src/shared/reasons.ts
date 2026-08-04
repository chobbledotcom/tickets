/**
 * One shared shape for "refuse this if any of these reasons holds — and say
 * which".
 *
 * A reason looks at a case and answers with the words to show when it blocks,
 * or null when it allows. Keeping a rule set as a list of reasons (instead of
 * an if/else-if chain) means one list serves every consumer: a save picks the
 * first reason to refuse with, a summary lists every reason at once, and a
 * picker can ask each candidate why it would be blocked before offering it.
 *
 * The sibling for "one check over many items" is `firstProblem` in `#fp`;
 * this module is "many reasons over one case".
 */

import { mapNotNullish } from "#fp";

/** Why a case is refused: the message to show, or null when this rule allows it. */
export type Reason<Args extends readonly unknown[]> = (
  ...args: Args
) => string | null;

/** Build a reason from a check plus the message for when it blocks. For rules
 * where the two read best apart; a reason whose message needs the evidence the
 * check found (WHICH sibling clashes) builds the message inline instead. */
export const reason =
  <Args extends readonly unknown[]>(
    blocks: (...args: Args) => boolean,
    message: (...args: Args) => string,
  ): Reason<Args> =>
  (...args) =>
    blocks(...args) ? message(...args) : null;

/** The first reason that blocks the case, or null when none does. List order
 * IS precedence: a case that breaks several rules reports the one declared
 * first, so the most fundamental rule goes first. Later reasons are not
 * evaluated after a hit, so they may assume the earlier rules passed. */
export const firstReason =
  <Args extends readonly unknown[]>(reasons: readonly Reason<Args>[]) =>
  (...args: Args): string | null => {
    for (const why of reasons) {
      const message = why(...args);
      if (message !== null) return message;
    }
    return null;
  };

/** Every reason that blocks the case, in declaration order — for surfaces that
 * must name every problem at once rather than refuse on the first. */
export const allReasons =
  <Args extends readonly unknown[]>(reasons: readonly Reason<Args>[]) =>
  (...args: Args): string[] =>
    mapNotNullish((why: Reason<Args>) => why(...args))(reasons);
