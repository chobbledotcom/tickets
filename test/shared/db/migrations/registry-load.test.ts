import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { entry } from "#db/migrations/registry-load.ts";

describe("db > migrations > registry load", () => {
  test("an entry carries its id and loads its builder", async () => {
    const builder = () => ({
      description: "hand-built for the test",
      id: "fixture-id",
      requires: {},
      up: async () => {},
      verify: async () => {},
    });

    const registered = entry("fixture-id", async () => ({
      default: builder,
    }));

    expect(registered.id).toBe("fixture-id");
    expect(await registered.load()).toEqual({ default: builder });
  });
});
