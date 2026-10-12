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
