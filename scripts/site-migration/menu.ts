import { requiredAnswer } from "#scripts/turso-migration-steps.ts";

/** What the person picked from a numbered menu: a row, or "stop". */
export type MenuChoice<T> = { chosen: T } | "quit";

export const QUIT_ANSWERS = ["q", "quit", "exit"];

/** Read a numbered choice, where "q" means stop. */
export const readMenuChoice = <T>(
  answer: string | null,
  rows: T[],
): MenuChoice<T> => {
  const value = requiredAnswer(answer, "Choice");
  if (QUIT_ANSWERS.includes(value.toLowerCase())) return "quit";
  if (!/^\d+$/.test(value)) throw new Error("Type a number, or q to quit.");
  const index = Number(value) - 1;
  const chosen = rows.at(index);
  if (index < 0 || chosen === undefined) {
    throw new Error(`Choose a number between 1 and ${rows.length}.`);
  }
  return { chosen };
};

/** Number a list of labels for display, starting at 1. */
export const numberedLines = (labels: string[]): string[] =>
  labels.map((label, index) => `  ${index + 1}. ${label}`);
