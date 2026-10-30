import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isSet,
  known,
  snapGetters,
  withProperties,
} from "#db/settings/namespace.ts";
import { settings } from "#db/settings.ts";

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

    // A spread would call the getter once, at assembly time, and freeze
    // "first" here.
    expect(merged.live).toBe("second");
  });

  test("keeps the generated getters enumerable", () => {
    const getters = snapGetters({ theme: "theme" });

    expect(Object.keys(getters)).toEqual(["theme"]);
  });

  test("reads an is-set getter from the snapshot", () => {
    const getters = snapGetters({ hasKey: isSet("superuser_choice") });

    settings.setForTest({ superuser_choice: "enabled" });
    try {
      expect(getters.hasKey).toBe(true);
      settings.setForTest({ superuser_choice: "" });
      expect(getters.hasKey).toBe(false);
    } finally {
      settings.clearTestOverrides();
    }
  });

  test("reads a known-value getter through its guard and fallback", () => {
    const getters = snapGetters({
      country: known({
        fallback: "US",
        isKnown: (candidate): candidate is "US" => candidate === "US",
        key: "country",
      }),
    });

    settings.setForTest({ country: "US" });
    try {
      expect(getters.country).toBe("US");
      settings.setForTest({ country: "Mars" });
      expect(getters.country).toBe("US");
    } finally {
      settings.clearTestOverrides();
    }
  });
});
