import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseCommand } from "#cli/commands.ts";
import { parseOrUsage, testTable } from "#test-utils/cli-table.ts";

/** Assert that a command is a usage error (exit 2) whose message names the
 *  fragment. */
const expectUsage = (args: string[], fragment: string): void => {
  const answer = parseOrUsage(args);
  expect(answer.code).toBe(2);
  assertStringIncludes(answer.message, fragment);
};

describe("CLI custom route filters", () => {
  test("parses the filtered external source reads with their query", () => {
    const cases: [string[], object][] = [
      [
        ["linkLookup", "external-sources", "external_id=ABC 1"],
        { id: undefined, query: { external_id: "ABC 1" } },
      ],
      [
        ["linkSearch", "external-sources", "link_type=listing", "link_id=4"],
        { id: undefined, query: { link_id: "4", link_type: "listing" } },
      ],
      [
        ["links", "external-sources", "3", "external_id=a=b"],
        { id: 3, query: { external_id: "a=b" } },
      ],
    ];
    for (const [args, expected] of cases) {
      const parsed: unknown = parseCommand(testTable, args);
      expect(parsed).toMatchObject({ kind: "custom", ...expected });
    }
  });

  test("answers exit 2 for a filter route call the route cannot take", () => {
    expectUsage(["linkLookup", "external-sources", "3"], "takes no id");
    expectUsage(["links", "external-sources", "a=b"], "needs the source id");
    expectUsage(
      ["linkLookup", "external-sources", "external_id=a", "external_id=b"],
      "'external_id' appears twice",
    );
  });
});
