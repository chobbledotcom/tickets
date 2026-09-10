import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveBiomeCommand } from "#scripts/biome-command.ts";

describe("Biome command resolution", () => {
  test("returns the native biome command with the given args", async () => {
    expect(await resolveBiomeCommand(["lint", "source.ts"])).toEqual({
      args: ["lint", "source.ts"],
      command: "biome",
    });
  });
});
