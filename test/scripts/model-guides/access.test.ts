import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { denoGuideAccess } from "#scripts/model-guides/access.ts";

describe("denoGuideAccess", () => {
  test("reads a repository file", async () => {
    expect(await denoGuideAccess.read("deno.json")).toContain(
      '"name": "tickets"',
    );
  });
});
