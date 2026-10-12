// test-groups: child-fixture — the filter tests run this file as a spawned
// child entry, so its module-level hook is the hidden global suite they prune.
import { beforeAll, describe, it } from "@std/testing/bdd";
import { mark } from "./marks.ts";

beforeAll(() => {
  mark("global hook ran");
});

it("standalone alpha", () => {
  mark("standalone alpha ran");
});

it("standalone beta", () => {
  mark("standalone beta ran");
});

describe("hooked group", () => {
  it("inner leaf", () => {
    mark("inner leaf ran");
  });
  it("other leaf", () => {
    mark("other leaf ran");
  });
});
