/**
 * Saying what is wrong with a stored payment record, or that nothing is.
 *
 * Every rule about how a payment behaves answers the same way: the one thing
 * wrong, or nothing at all. The record layer runs them on the way in and
 * refuses the write with whatever they say.
 */

/** Reads as "nothing was wrong" or the one thing that was. */
export type Fault = string | null;

/** The first rule in a list that did not hold. */
export const firstFault = (checks: [boolean, string][]): Fault =>
  checks.find(([holds]) => !holds)?.[1] ?? null;

/** The first of several answers that found something wrong. */
export const firstOf = (...faults: Fault[]): Fault =>
  faults.find((fault) => fault !== null) ?? null;

export const present = (value: unknown): boolean =>
  value !== null && value !== undefined;

/**
 * Whether every value here either is not there at all, or is text with
 * something in it. A code made only of spaces, tabs or newlines looks like a
 * value to every check that asks whether one is there, but nothing can ever
 * be found by it and no worker's claim on it means anything.
 */
export const allSaySomething = (values: (string | null)[]): boolean =>
  values.every((value) => value === null || value.trim() !== "");
export const absent = (value: unknown): boolean => !present(value);
export const allAbsent = (values: unknown[]): boolean => values.every(absent);
