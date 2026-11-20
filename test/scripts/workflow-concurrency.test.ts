import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const readTest = () => Deno.readTextFile(".github/workflows/test.yml");

describe("test workflow concurrency", () => {
  test("groups runs by branch", async () => {
    expect(await readTest()).toContain(
      "concurrency:\n  group: test-${{ github.ref }}\n",
    );
  });

  test("cancels an outdated push run but never a merge queue run", async () => {
    expect(await readTest()).toContain(
      "cancel-in-progress: ${{ github.event_name == 'push' }}",
    );
  });
});
