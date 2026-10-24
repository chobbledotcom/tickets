import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { joinedNonEmpty } from "#shared/joined-text.ts";

describe("joinedNonEmpty", () => {
  test("joins the parts that exist with the separator", () => {
    expect(joinedNonEmpty(".")(["alias", "column"])).toBe("alias.column");
    expect(joinedNonEmpty(" ")(["form", "wide"])).toBe("form wide");
  });

  test("drops absent and empty parts", () => {
    expect(joinedNonEmpty(".")([undefined, "column"])).toBe("column");
    expect(joinedNonEmpty(".")(["", "column"])).toBe("column");
    expect(joinedNonEmpty(" ")(["base", ""])).toBe("base");
    expect(joinedNonEmpty(".")([undefined, undefined])).toBe("");
  });
});
