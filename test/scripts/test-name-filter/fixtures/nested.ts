import { describe, it } from "@std/testing/bdd";

describe("outer group", () => {
  describe("inner group", () => {
    it("leaf alpha", () => {});
    it("leaf beta", () => {});
  });
  describe("empty middle", () => {
    describe("empty inner", () => {
      it("leaf gamma", () => {});
    });
  });
});
