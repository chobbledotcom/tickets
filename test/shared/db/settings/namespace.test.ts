import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withProperties } from "#shared/db/settings/namespace.ts";

describe("db > settings namespace", () => {
  test("adds every property of the part to the target", () => {
    const target = { alreadyHere: "kept" };

    const merged = withProperties(target, { added: "new" });

    // The settings namespace merges its parts one after another, each onto the
    // object the last one returned.
    expect(merged).toBe(target);
    expect({ added: merged.added, alreadyHere: merged.alreadyHere }).toEqual({
      added: "new",
      alreadyHere: "kept",
    });
  });

  test("keeps a getter a getter, so it reads the value at read time", () => {
    let stored = "first";
    const part = {
      get live(): string {
        return stored;
      },
    };

    const merged = withProperties({}, part);
    stored = "second";

    // A spread would have called the getter once, at assembly time, and
    // frozen "first" here.
    expect(merged.live).toBe("second");
  });
});
