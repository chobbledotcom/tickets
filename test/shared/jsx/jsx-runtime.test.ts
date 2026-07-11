import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  Fragment,
  jsx,
  Raw,
  SafeHtml,
  VOID_ELEMENTS,
} from "#jsx/jsx-runtime.ts";

// The HTML void elements, as a fixed spec list independent of the production
// table. Driving the render tests from this (rather than from VOID_ELEMENTS
// itself) means dropping a tag from VOID_ELEMENTS makes jsx() render it with a
// closing tag and these tests FAIL — instead of silently no longer testing it.
const EXPECTED_VOID_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
] as const;

describe("jsx-runtime", () => {
  describe("jsx", () => {
    test("renders element with text child", () => {
      const result = jsx("div", { children: "hello" });
      expect(result.toString()).toBe("<div>hello</div>");
    });

    test("renders element with number child", () => {
      const result = jsx("span", { children: 42 });
      expect(result.toString()).toBe("<span>42</span>");
    });

    test("renders element with boolean true child as empty", () => {
      const result = jsx("div", { children: true });
      expect(result.toString()).toBe("<div></div>");
    });

    test("renders element with boolean false child as empty", () => {
      const result = jsx("div", { children: false });
      expect(result.toString()).toBe("<div></div>");
    });

    test("renders element with null child as empty", () => {
      const result = jsx("div", { children: null });
      expect(result.toString()).toBe("<div></div>");
    });

    test("renders element with undefined child as empty", () => {
      const result = jsx("div", { children: undefined });
      expect(result.toString()).toBe("<div></div>");
    });

    for (const tag of EXPECTED_VOID_ELEMENTS) {
      test(`renders <${tag}> self-closing without a closing tag`, () => {
        const result = jsx(tag, null);
        expect(result.toString()).toBe(`<${tag}>`);
      });
    }

    test("VOID_ELEMENTS table matches the HTML void-element spec exactly", () => {
      // Pin the production table to the spec list: adding or removing a tag
      // here (or there) is a deliberate change that must update both.
      expect(Object.keys(VOID_ELEMENTS).sort()).toEqual(
        [...EXPECTED_VOID_ELEMENTS].sort(),
      );
    });

    test("renders void element with attributes", () => {
      const result = jsx("input", { name: "foo", type: "text" });
      expect(result.toString()).toBe('<input name="foo" type="text">');
    });

    test("renders a non-void element with an explicit closing tag", () => {
      const result = jsx("div", null);
      expect(result.toString()).toBe("<div></div>");
    });

    test("renders boolean attribute as name only when true", () => {
      const result = jsx("input", { required: true });
      expect(result.toString()).toBe("<input required>");
    });

    test("omits boolean attribute when false", () => {
      const result = jsx("input", { required: false });
      expect(result.toString()).toBe("<input>");
    });

    test("omits attribute when value is null", () => {
      const result = jsx("input", { name: null });
      expect(result.toString()).toBe("<input>");
    });

    test("omits attribute when value is undefined", () => {
      const result = jsx("input", { name: undefined });
      expect(result.toString()).toBe("<input>");
    });

    test("escapes text children", () => {
      const result = jsx("div", { children: "<script>alert(1)</script>" });
      expect(result.toString()).toContain("&lt;script&gt;");
    });

    test("escapes attribute values", () => {
      const result = jsx("div", { title: 'say "hello"' });
      expect(result.toString()).toContain('title="say &quot;hello&quot;"');
    });

    test("renders component that returns SafeHtml", () => {
      const Component = () => new SafeHtml("<p>test</p>");
      const result = jsx(Component, null);
      expect(result.toString()).toBe("<p>test</p>");
    });

    test("renders component that returns string", () => {
      const Component = () => "<p>test</p>";
      const result = jsx(Component, null);
      expect(result.toString()).toBe("<p>test</p>");
    });

    test("passes props to component", () => {
      const Component = (props: Record<string, unknown>) =>
        `Hello ${props.name}`;
      const result = jsx(Component, { name: "World" });
      expect(result.toString()).toBe("Hello World");
    });

    test("renders nested SafeHtml children without escaping", () => {
      const inner = new SafeHtml("<b>bold</b>");
      const result = jsx("div", { children: inner });
      expect(result.toString()).toBe("<div><b>bold</b></div>");
    });

    test("renders array of children", () => {
      const result = jsx("div", { children: ["a", "b", "c"] });
      expect(result.toString()).toBe("<div>abc</div>");
    });
  });

  describe("Fragment", () => {
    test("renders children without wrapper", () => {
      const result = Fragment({ children: "hello" });
      expect(result.toString()).toBe("hello");
    });

    test("renders array children without wrapper", () => {
      const result = Fragment({ children: ["a", "b", "c"] });
      expect(result.toString()).toBe("abc");
    });

    test("escapes text in fragment", () => {
      const result = Fragment({ children: "<script>" });
      expect(result.toString()).toBe("&lt;script&gt;");
    });

    test("passes through single SafeHtml child without re-wrapping", () => {
      const inner = new SafeHtml("<b>bold</b>");
      const result = jsx(Fragment, { children: inner });
      expect(result).toBe(inner);
      expect(result.toString()).toBe("<b>bold</b>");
    });
  });

  describe("Raw", () => {
    test("returns unescaped HTML", () => {
      const result = Raw({ html: "<b>bold</b>" });
      expect(result.toString()).toBe("<b>bold</b>");
    });
  });

  describe("SafeHtml", () => {
    test("toString returns html content", () => {
      const safe = new SafeHtml("<p>test</p>");
      expect(safe.toString()).toBe("<p>test</p>");
      expect(String(safe)).toBe("<p>test</p>");
    });
  });
});
