import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sha256Hex } from "#scripts/checksum.ts";

describe("SHA-256 checksum", () => {
  test("returns a lowercase fixed-width hex digest", async () => {
    expect(await sha256Hex(new TextEncoder().encode("tickets"))).toBe(
      "45a5c62241eec841f042aee5ae4626a40ea31e8393aa44d0f9ce801d0325ae5d",
    );
  });
});
