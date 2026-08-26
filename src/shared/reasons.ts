/**
 * "Refuse this if any of these reasons holds, and say which."
 *
 * A list of reasons rather than an if/else chain means ONE list serves every
 * consumer: a save picks the first refusal, a summary lists them all, and a
 * picker asks each candidate why it would be blocked before offering it.
 *
 * The sibling for "one check over many items" is `firstProblem` in `#fp`.
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

/** A runner takes a rule list and gives back the function of the case — the
 * one shared signature of `firstReason` and `allReasons`. */
type ReasonRunner<Out> = <Args extends readonly unknown[]>(
  reasons: readonly Reason<Args>[],
) => (...args: Args) => Out;

/** The first reason that blocks the case, or null when none does — itself a
 * {@link Reason}, so rule lists compose. List order IS precedence: a case that
 * breaks several rules reports the one declared first, so the most fundamental
 * rule goes first. Later reasons are not evaluated after a hit, so they may
 * assume the earlier rules passed. */
export const firstReason: ReasonRunner<string | null> =
  (reasons) =>
  (...args) => {
    for (const why of reasons) {
      const message = why(...args);
      if (message !== null) return message;
    }
    return null;
  };

/** Every reason that blocks the case, in declaration order — for surfaces that
 * must name every problem at once rather than refuse on the first. */
export const allReasons: ReasonRunner<string[]> =
  (reasons) =>
  (...args) =>
    mapNotNullish((why: (typeof reasons)[number]) => why(...args))(reasons);
