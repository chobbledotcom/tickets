import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findIssues } from "#scripts/check-empty-catch/rules.ts";

describe("check-empty-catch rules", () => {
  test("flags a catch block that holds nothing", () => {
    const issues = findIssues("one.ts", "try {\n  save();\n} catch (e) {}\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe("catch (e)");
    expect(issues[0]?.line).toBe(3);
  });

  test("flags a parameterless empty catch, inside a nested function", () => {
    const issues = findIssues(
      "two.ts",
      "const run = () => {\n  try {\n    save();\n  } catch {}\n};\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe("catch");
    expect(issues[0]?.line).toBe(4);
  });

  test("lets a catch that states its fallback in a comment stand", () => {
    expect(
      findIssues(
        "three.ts",
        "try {\n  save();\n} catch (e) {\n  // Fall back to the raw value.\n}\n",
      ),
    ).toEqual([]);
  });

  test("lets a catch that recovers stand", () => {
    expect(
      findIssues(
        "four.ts",
        "try {\n  save();\n} catch (e) {\n  recover(e);\n}\n",
      ),
    ).toEqual([]);
  });

  test("leaves a swallowed promise callback alone", () => {
    expect(
      findIssues("five.ts", "addPendingWork(touch().catch(() => {}));\n"),
    ).toEqual([]);
  });

  test("reports the finding with the rule's fix", () => {
    const [issue] = findIssues("six.ts", "try {\n} catch (e) {}\n");
    expect(issue?.rule).toBe("empty-catch");
    expect(issue?.problem).toContain("no statement");
    expect(issue?.fix).toContain("re-raise");
  });
});
