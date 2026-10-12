import { afterAll, beforeEach, describe, it } from "@std/testing/bdd";
import { mark } from "./marks.ts";

describe("kept group", () => {
  it("kept leaf", () => {
    mark("kept leaf ran");
  });
});

describe("pruned group", () => {
  let setups = 0;

  beforeEach(() => {
    setups += 1;
    mark("pruned setup ran");
  });

  it("pruned leaf", () => {
    mark("pruned leaf ran");
  });

  afterAll(() => {
    mark(`pruned afterAll ran after ${setups} setups`);
  });
});
