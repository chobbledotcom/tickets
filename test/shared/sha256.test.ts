import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sha256Hex } from "#shared/sha256.ts";

describe("SHA-256 digest", () => {
  test("returns a lowercase fixed-width hex digest", async () => {
    expect(await sha256Hex(new TextEncoder().encode("tickets"))).toBe(
      "45a5c62241eec841f042aee5ae4626a40ea31e8393aa44d0f9ce801d0325ae5d",
    );
  });

  test("hashes one text as its UTF-8 bytes", async () => {
    expect(await sha256Hex("tickets")).toBe(
      "45a5c62241eec841f042aee5ae4626a40ea31e8393aa44d0f9ce801d0325ae5d",
    );
  });
});
