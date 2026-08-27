import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { replacing } from "#shared/replacements.ts";

describe("replacing", () => {
  test("applies every replacement", () => {
    expect(replacing([/a/g, "1"], [/b/g, "2"])("abab")).toBe("1212");
  });

  test("applies them in the order given, so a later one sees the earlier", () => {
    expect(replacing([/a/g, "b"], [/b/g, "c"])("a")).toBe("c");
    expect(replacing([/b/g, "c"], [/a/g, "b"])("a")).toBe("b");
  });

  test("leaves text no pattern matches exactly as it was", () => {
    expect(replacing([/x/g, "y"])("abc")).toBe("abc");
  });

  test("changes nothing when there is nothing to replace", () => {
    expect(replacing()("abc")).toBe("abc");
  });

  test("replaces only the first match when the pattern is not global", () => {
    expect(replacing([/a/, "z"])("aaa")).toBe("zaa");
  });
});
