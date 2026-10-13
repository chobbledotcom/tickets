import { describe, it } from "@std/testing/bdd";

describe("all ignored group", () => {
  it("ignored leaf", { ignore: true }, () => {});
});

it("ignored standalone", { ignore: true }, () => {});
