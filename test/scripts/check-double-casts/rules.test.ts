import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  countDoubleCasts,
  findIssues,
} from "#scripts/check-double-casts/rules.ts";

describe("check-double-casts rules", () => {
  test("counts the double casts one file's content holds", () => {
    expect(countDoubleCasts("a.ts", "const a = b as unknown as Bar;\n")).toBe(
      1,
    );
    expect(
      countDoubleCasts(
        "a.ts",
        "const c = d as Foo;\nconst e = f as unknown;\n",
      ),
    ).toBe(0);
  });

  test("flags a file with a cast that no entry covers", () => {
    const [issue] = findIssues(
      "new.ts",
      "const a = b as unknown as Bar;\n",
      {},
    );
    expect(issue?.rule).toBe("double-cast");
    expect(issue?.line).toBe(1);
    assertExists(issue);
    assertStringIncludes(issue.fix, "narrow");
  });

  test("reads the cast only where code casts, not in comments or strings", () => {
    const source =
      '// as unknown as never\nconst s = "as unknown as string";\n';
    expect(findIssues("quoted.ts", source, {})).toEqual([]);
  });

  test("leaves a stacked cast that does not bridge through unknown alone", () => {
    expect(
      findIssues("stacked.ts", "const a = b as string as number;\n", {}),
    ).toEqual([]);
  });

  test("lets a covered file at its recorded count stand", () => {
    expect(
      findIssues("held.ts", "const a = b as unknown as Bar;\n", {
        "held.ts": 1,
      }),
    ).toEqual([]);
  });

  test("flags every cast in a covered file that grew past its count", () => {
    const issues = findIssues(
      "grew.ts",
      "const a = b as unknown as Bar;\nconst c = d as unknown as Foo;\n",
      { "grew.ts": 1 },
    );
    expect(issues).toHaveLength(2);
    expect(issues[1]?.line).toBe(2);
  });

  test("fails when a covered file shrank, so the step lands with its entry", () => {
    const [issue] = findIssues(
      "shrank.ts",
      "const a = b as unknown as Bar;\n",
      { "shrank.ts": 2 },
    );
    expect(issue?.rule).toBe("improved");
    assertExists(issue);
    assertStringIncludes(issue.problem, "down from the recorded 2");
  });

  test("fails when an entry names a file that casts no more", () => {
    const [issue] = findIssues("done.ts", "export {};\n", { "done.ts": 3 });
    expect(issue?.rule).toBe("stale-entry");
    assertExists(issue);
    assertStringIncludes(issue.fix, "delete the entry");
  });
});
