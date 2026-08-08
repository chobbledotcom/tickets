import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Liquid } from "liquidjs";
import { validateTemplate } from "#shared/email-renderer.ts";
import { describeEmailRenderer } from "./test-helpers.ts";

describeEmailRenderer(() => {
  describe("validateTemplate", () => {
    test("returns null for valid template", () => {
      expect(validateTemplate("Hello {{ name }}")).toBeNull();
    });

    test("returns null for template with for loop", () => {
      expect(
        validateTemplate("{% for x in items %}{{ x }}{% endfor %}"),
      ).toBeNull();
    });

    test("returns error for unclosed tag", () => {
      const error = validateTemplate("{% for x in items %}{{ x }}");
      expect(error).not.toBeNull();
    });

    test("returns error for invalid syntax", () => {
      const error = validateTemplate("{% invalid_tag %}");
      expect(error).not.toBeNull();
    });

    test("returns null for empty template", () => {
      expect(validateTemplate("")).toBeNull();
    });

    test("returns string representation of non-Error thrown value", () => {
      const parseStub = stub(Liquid.prototype, "parse", () => {
        throw "raw string parse error";
      });
      try {
        const result = validateTemplate("anything");
        expect(result).toBe("raw string parse error");
      } finally {
        parseStub.restore();
      }
    });
  });
});
