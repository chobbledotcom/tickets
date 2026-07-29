import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { questionTextFlat } from "#templates/admin/questions.tsx";

describe("questionTextFlat", () => {
  test("returns plain text unchanged", () => {
    expect(questionTextFlat("What is your T-shirt size?")).toBe(
      "What is your T-shirt size?",
    );
  });

  test("replaces a single newline with ' / '", () => {
    expect(questionTextFlat("Line 1\nLine 2")).toBe("Line 1 / Line 2");
  });

  test("replaces multiple newlines with ' / '", () => {
    expect(questionTextFlat("A\nB\nC")).toBe("A / B / C");
  });

  test("replaces Windows-style CRLF newlines", () => {
    expect(questionTextFlat("A\r\nB")).toBe("A / B");
  });

  test("preserves markdown syntax (does not render it)", () => {
    const result = questionTextFlat("**bold** and [link](https://x.com)");
    expect(result).toBe("**bold** and [link](https://x.com)");
  });

  test("flattens multi-line markdown to a single line", () => {
    const result = questionTextFlat("# Heading\n\nSome **bold** text");
    expect(result).not.toContain("\n");
    expect(result).toBe("# Heading /  / Some **bold** text");
  });
});
