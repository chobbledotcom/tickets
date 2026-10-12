import { describe, it } from "@std/testing/bdd";
import { mark } from "./marks.ts";

Deno.test("plain test", () => {
  mark("plain test ran");
});

describe("wrapped group", () => {
  it("wrapped leaf", () => {
    mark("wrapped leaf ran");
  });
});
