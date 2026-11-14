import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

/** One rule case: what it checks, the input, and the refusal, or null when
 *  the rule passes the input through unchanged. */
export type RuleCase<Input> = readonly [string, Input, string | null];

/** Declare one test per case for a rule that passes its input through or
 *  refuses it with a message. */
export const describeRuleCases = <Input>(
  title: string,
  rule: (input: Input) => unknown,
  cases: readonly RuleCase<Input>[],
): void => {
  describe(title, () => {
    for (const [name, input, error] of cases) {
      test(name, () => {
        expect(rule(input)).toEqual(
          error === null ? { ok: true, value: input } : { error, ok: false },
        );
      });
    }
  });
};
