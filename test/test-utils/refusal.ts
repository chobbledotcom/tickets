/** One implementation for tests that pin how a helper refuses its input. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

/** Registers a test that `call` throws, with a message that names the input
 *  it refuses. */
export const testRefusal = (
  name: string,
  call: () => unknown,
  message: string,
): void => {
  test(name, () => {
    expect(call).toThrow(message);
  });
};
