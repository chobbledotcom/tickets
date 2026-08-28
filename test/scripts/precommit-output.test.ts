import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  filterTestOutput,
  testProgressFromLine,
} from "#scripts/precommit/output.ts";

describe("precommit test output", () => {
  test("keeps everything from the first failure section onward", () => {
    const output = filterTestOutput(
      "Running tests...\nok fine\nFAILED\nboom",
      "tail",
    );

    expect(output).toBe("FAILED\nboom\ntail");
  });

  test("keeps a section that starts with either summary table row", () => {
    for (const row of ["FAILED | file", "ok   | file"]) {
      expect(filterTestOutput(`${row}\ncontext`, "")).toContain("context");
    }
  });

  test("falls back to error lines when no section starts", () => {
    const output = filterTestOutput("ok fine\nerror: broken", "");

    expect(output).toBe("error: broken");
  });

  test("reads progress from each kind of runner line", () => {
    expect(testProgressFromLine("Running tests...")).toBe("(starting tests)");
    expect(testProgressFromLine("ok   [##-----]  5/10 name")).toBe("(5/10)");
    expect(testProgressFromLine("fail [#-------]  1/2 name")).toBe("(1/2)");
    expect(testProgressFromLine("ok  [ 3 done]")).toBe("(3 done)");
    expect(testProgressFromLine("Checking coverage...")).toBe(
      "(checking coverage)",
    );
    expect(testProgressFromLine("anything else")).toBeUndefined();
  });
});
