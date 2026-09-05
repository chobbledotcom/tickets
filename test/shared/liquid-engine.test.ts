import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";

describe("createBaseLiquidEngine", () => {
  test("renders values through the currency filter", () => {
    const engine = createBaseLiquidEngine();
    expect(engine.parseAndRenderSync("{{ 2000 | currency }}")).toBe("£20");
  });

  test("renders values through the pluralize filter", () => {
    const engine = createBaseLiquidEngine();
    expect(
      engine.parseAndRenderSync('{{ 1 | pluralize: "ticket", "tickets" }}'),
    ).toBe("ticket");
    expect(
      engine.parseAndRenderSync('{{ 2 | pluralize: "ticket", "tickets" }}'),
    ).toBe("tickets");
  });

  test("rejects an unknown filter", () => {
    const engine = createBaseLiquidEngine();
    expect(() => engine.parseAndRenderSync("{{ 1 | nope }}")).toThrow();
  });

  test("renders a missing variable as empty", () => {
    const engine = createBaseLiquidEngine();
    expect(engine.parseAndRenderSync("a{{ missing }}b", {})).toBe("ab");
  });

  test("leaves interpolations unescaped by default", () => {
    const engine = createBaseLiquidEngine();
    expect(engine.parseAndRenderSync("{{ v }}", { v: '<b>"&"</b>' })).toBe(
      '<b>"&"</b>',
    );
  });

  test("escapes interpolations when output escaping is on", () => {
    const engine = createBaseLiquidEngine({ outputEscape: "escape" });
    expect(engine.parseAndRenderSync("{{ v }}", { v: '<b>"&"</b>' })).toBe(
      "&lt;b&gt;&#34;&amp;&#34;&lt;/b&gt;",
    );
  });

  test("an escaping engine has no raw filter to undo the escaping", () => {
    const engine = createBaseLiquidEngine({ outputEscape: "escape" });
    expect(() =>
      engine.parseAndRenderSync("{{ v | raw }}", { v: "<b>x</b>" }),
    ).toThrow();
  });

  test("keeps template markup intact while escaping values", () => {
    const engine = createBaseLiquidEngine({ outputEscape: "escape" });
    expect(
      engine.parseAndRenderSync("<strong>{{ v }}</strong>", { v: "<i>x</i>" }),
    ).toBe("<strong>&lt;i&gt;x&lt;/i&gt;</strong>");
  });
});
