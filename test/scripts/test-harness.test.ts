import { expect } from "@std/expect";
import { runTests } from "#scripts/test-harness.ts";

Deno.test("runTests refuses a filtered run that uses a custom reporter", async () => {
  await expect(
    runTests(["test/", "--filter", "nothing", "--reporter=dot"], false),
  ).rejects.toThrow(
    "A filtered run cannot use a custom reporter: the runner cannot tell whether any test matched.",
  );
});
