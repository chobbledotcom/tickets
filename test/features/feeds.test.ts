import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { escapeIcs, escapeXml } from "#routes/feeds.ts";

describe("escapeIcs", () => {
  test("escapes each character iCalendar reserves", () => {
    expect(escapeIcs("a;b")).toBe("a\\;b");
    expect(escapeIcs("a,b")).toBe("a\\,b");
    expect(escapeIcs("a\nb")).toBe("a\\nb");
  });

  test("escapes the backslash first, so an escape is not escaped twice", () => {
    expect(escapeIcs("\\")).toBe("\\\\");
    expect(escapeIcs("\\;")).toBe("\\\\\\;");
  });

  test("escapes every occurrence, not only the first", () => {
    expect(escapeIcs("a;b;c")).toBe("a\\;b\\;c");
  });

  test("leaves text with nothing to escape as it was", () => {
    expect(escapeIcs("Summer party 2026")).toBe("Summer party 2026");
  });
});

describe("escapeXml", () => {
  test("escapes what HTML escaping covers", () => {
    expect(escapeXml("<a>&")).toBe("&lt;a&gt;&amp;");
  });

  test("escapes the apostrophe HTML escaping leaves alone", () => {
    expect(escapeXml("it's")).toBe("it&apos;s");
  });

  test("escapes the double quote too", () => {
    expect(escapeXml('say "hi"')).toBe("say &quot;hi&quot;");
  });
});
