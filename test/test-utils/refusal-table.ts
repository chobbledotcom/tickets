/** One test per case for a write that answers a refusal result. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

/** Register one test per case: the attempt answers the case's message as a
 *  refusal. */
export const testEachRefusal = <Input>(
  attempt: (input: Input) => Promise<unknown>,
  cases: readonly (readonly [name: string, input: Input, error: string])[],
): void => {
  for (const [name, input, error] of cases) {
    test(name, async () => {
      expect(await attempt(input)).toEqual({ error, ok: false });
    });
  }
};
