// effects: pure
/** Run steps one after another. */

import { okResult, type Result } from "#shared/result.ts";

/** Turn the value of a result. An error passes on as it is. */
export const mapped = <Answer, Value>(
  result: Result<Answer>,
  map: (answer: Answer) => Value,
): Result<Value> => (result.ok ? okResult(map(result.value)) : result);

/** Run the next step on a value that an earlier step found. An error stops
 * the chain and passes on as it is. */
export const andThen = async <From, To>(
  result: Promise<Result<From>>,
  next: (value: From) => Promise<Result<To>>,
): Promise<Result<To>> => {
  const done = await result;
  return done.ok ? next(done.value) : done;
};

/** Run one step for each item, in order, and stop at the first failure. The
 * answer holds what each step reported. */
export const eachInOrder = async <Item, Report>(
  items: readonly Item[],
  step: (item: Item) => Promise<Result<Report>>,
): Promise<Result<Report[]>> => {
  const reports: Report[] = [];
  for (const item of items) {
    const done = await step(item);
    if (!done.ok) return done;
    reports.push(done.value);
  }
  return okResult(reports);
};

/** Run each step in order, and stop at the first failure. The answer joins
 * the lines that the steps reported. */
export const inSequence = async (
  steps: readonly (() => Promise<Result<string[]>>)[],
): Promise<Result<string[]>> => {
  const reports = await eachInOrder(steps, (step) => step());
  return reports.ok ? okResult(reports.value.flat()) : reports;
};
