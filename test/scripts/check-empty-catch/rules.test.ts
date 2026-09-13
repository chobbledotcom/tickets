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

  test("flags a swallowed promise callback", () => {
    const issues = findIssues(
      "five.ts",
      "addPendingWork(touch().catch(() => {}));\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe(".catch");
    expect(issues[0]?.line).toBe(1);
  });

  test("lets a promise callback that states its fallback stand", () => {
    expect(
      findIssues(
        "seven.ts",
        "touch().catch(() => {\n  // The stats write must not fail the request.\n});\n",
      ),
    ).toEqual([]);
  });

  test("lets a promise callback that recovers stand", () => {
    expect(findIssues("eight.ts", "touch().catch(() => save());\n")).toEqual(
      [],
    );
  });

  test("leaves an empty callback on another member alone", () => {
    expect(findIssues("nine.ts", "items.map(() => {});\n")).toEqual([]);
  });

  test("leaves a catch call with no callback alone", () => {
    expect(findIssues("ten.ts", "touch().catch();\n")).toEqual([]);
  });

  test("leaves a named handler alone, empty or not", () => {
    expect(findIssues("eleven.ts", "touch().catch(handleIt);\n")).toEqual([]);
  });

  test("flags an empty function-expression callback", () => {
    const issues = findIssues(
      "thirteen.ts",
      "touch().catch(function () {});\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe(".catch");
  });

  test("flags an empty callback reached through a computed catch", () => {
    const issues = findIssues("fourteen.ts", 'touch()["catch"](() => {});\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe(".catch");
  });

  test("flags an empty rejection handler passed to then", () => {
    // Spelled computed so the repo's own no-.then rule does not read the
    // fixture as a real call.
    const issues = findIssues(
      "sixteen.ts",
      'touch()["then"](useIt, () => {});\n',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.caught).toBe(".then rejection handler");
    expect(issues[0]?.line).toBe(1);
  });

  test("leaves a then call with no rejection handler alone", () => {
    expect(findIssues("seventeen.ts", 'touch()["then"](useIt);\n')).toEqual([]);
  });

  test("lets a recovering then rejection handler stand", () => {
    expect(
      findIssues("eighteen.ts", 'touch()["then"](useIt, () => save());\n'),
    ).toEqual([]);
  });

  test("leaves a computed member with a non-string key alone", () => {
    expect(findIssues("fifteen.ts", "touch()[0](() => {});\n")).toEqual([]);
  });

  test("lets a callback that recovers inside braces stand", () => {
    expect(
      findIssues("twelve.ts", "touch().catch(() => {\n  save();\n});\n"),
    ).toEqual([]);
  });

  test("reports the finding with the rule's fix", () => {
    const [issue] = findIssues("six.ts", "try {\n} catch (e) {}\n");
    expect(issue?.rule).toBe("empty-catch");
    expect(issue?.problem).toContain("no statement");
    expect(issue?.fix).toContain("re-raise");
  });
});
