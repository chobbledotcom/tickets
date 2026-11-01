import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkVerification } from "#scripts/check-tla/run.ts";

test("every maintained model and helper meets the source policy", async () => {
  const errors: string[] = [];
  const result = await checkVerification({
    log: () => {},
    logError: (line) => errors.push(line),
  });
  expect({ errors, result }).toEqual({ errors: [], result: 0 });
});
