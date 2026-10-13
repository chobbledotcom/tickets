import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { escapeXml } from "#shared/xml.ts";

describe("escapeXml", () => {
  test("escapes every XML-special character", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  test("leaves text that holds nothing to escape alone", () => {
    expect(escapeXml("plans-pricing_1+2")).toBe("plans-pricing_1+2");
  });
});
