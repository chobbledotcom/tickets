import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

/** One table row: the test name, the inputs the subject reads, and the one
 *  result each of them must give. */
export type Case<Input, Output> = readonly [
  name: string,
  inputs: readonly Input[],
  expected: Output,
];

/**
 * Run one test per row, so a family of same-shaped cases reads as data. A row
 * lists every input that must produce its `expected` result, which keeps a
 * multi-input test under one name and one assertion shape.
 */
export const testCases = <Input, Output>(
  cases: readonly Case<Input, Output>[],
  subject: (input: Input) => Output,
): void => {
  for (const [name, inputs, expected] of cases) {
    test(name, () => {
      for (const input of inputs) {
        expect(subject(input)).toEqual(expected);
      }
    });
  }
};
