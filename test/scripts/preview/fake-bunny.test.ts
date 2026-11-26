import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fakeBunny } from "./fake-bunny.ts";

describe("fakeBunny", () => {
  test("answers a call it has no route for with a 404 that names the call", async () => {
    const bunny = fakeBunny();

    expect(await bunny.fetchText("https://api.bunny.net/nowhere", {})).toEqual({
      ok: false,
      status: 404,
      text: '{"Message":"unrouted GET /nowhere"}',
    });
  });
});
