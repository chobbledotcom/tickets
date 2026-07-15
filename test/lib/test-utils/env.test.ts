import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getRealEnv, withEnv } from "#test-utils/env.ts";

const SET_KEY = "TICKETS_TEST_WITH_ENV_SET";
const DELETE_KEY = "TICKETS_TEST_WITH_ENV_DELETE";
const REAL_KEY = "TICKETS_TEST_WITH_ENV_REAL";

describe("withEnv", () => {
  test("sets one value for its scope", () => {
    using _env = withEnv({ [SET_KEY]: "inside" });
    expect(Deno.env.get(SET_KEY)).toBe("inside");
  });

  test("deletes one value for its scope", () => {
    using _outside = withEnv({ [DELETE_KEY]: "outside" });
    {
      using _inside = withEnv({ [DELETE_KEY]: undefined });
      expect(Deno.env.get(DELETE_KEY)).toBeUndefined();
    }
    expect(Deno.env.get(DELETE_KEY)).toBe("outside");
  });

  test("restores present and absent values exactly", () => {
    using _outside = withEnv({ [DELETE_KEY]: undefined, [SET_KEY]: "before" });
    {
      using _inside = withEnv({ [DELETE_KEY]: "added", [SET_KEY]: "changed" });
      expect(Deno.env.get(DELETE_KEY)).toBe("added");
      expect(Deno.env.get(SET_KEY)).toBe("changed");
    }
    expect(Deno.env.get(DELETE_KEY)).toBeUndefined();
    expect(Deno.env.get(SET_KEY)).toBe("before");
  });

  test("keeps later changes inside the same scope", () => {
    using _outside = withEnv({ [SET_KEY]: "before" });
    {
      using _inside = withEnv({ [SET_KEY]: "first" });
      Deno.env.set(SET_KEY, "second");
      expect(Deno.env.get(SET_KEY)).toBe("second");
      Deno.env.delete(SET_KEY);
      expect(Deno.env.get(SET_KEY)).toBeUndefined();
    }
    expect(Deno.env.get(SET_KEY)).toBe("before");
  });

  test("passes keys outside its scope through to the process env", () => {
    expect(getRealEnv(REAL_KEY)).toBeUndefined();
    using _env = withEnv({ [SET_KEY]: "inside" });
    try {
      Deno.env.set(REAL_KEY, "real");
      expect(getRealEnv(REAL_KEY)).toBe("real");
      Deno.env.delete(REAL_KEY);
      expect(getRealEnv(REAL_KEY)).toBeUndefined();
    } finally {
      Deno.env.delete(REAL_KEY);
    }
  });

  test("restores values after work throws", () => {
    using _outside = withEnv({ [SET_KEY]: "before" });
    expect(() => {
      using _inside = withEnv({ [SET_KEY]: "inside" });
      throw new Error("stop");
    }).toThrow("stop");
    expect(Deno.env.get(SET_KEY)).toBe("before");
  });
});
