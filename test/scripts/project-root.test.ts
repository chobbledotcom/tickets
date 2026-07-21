import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toDisplayPath } from "#scripts/project-root.ts";

describe("toDisplayPath", () => {
  test("strips a leading ./ from a relative path", () => {
    expect(toDisplayPath("/base", "./src/index.ts")).toBe("src/index.ts");
  });

  test("leaves a bare relative path unchanged", () => {
    expect(toDisplayPath("/base", "src/index.ts")).toBe("src/index.ts");
  });

  test("shows an absolute path inside the base as base-relative", () => {
    expect(toDisplayPath("/base", "/base/src/index.ts")).toBe("src/index.ts");
  });

  test("renders the base itself as '.'", () => {
    expect(toDisplayPath("/base", "/base")).toBe(".");
  });

  test("keeps an absolute path that escapes the base", () => {
    expect(toDisplayPath("/base/sub", "/other/x.ts")).toBe("/other/x.ts");
  });

  test("keeps the parent directory itself (relative '..')", () => {
    expect(toDisplayPath("/base/sub", "/base")).toBe("/base");
  });

  test("does not treat a '..'-prefixed filename as escaping", () => {
    expect(toDisplayPath("/base", "/base/..cache.ts")).toBe("..cache.ts");
  });
});
