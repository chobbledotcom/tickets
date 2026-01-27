import { describe, expect, test } from "#test-compat";
import { minifyCss } from "../../scripts/css-minify.ts";

describe("build-edge", () => {
  describe("minifyCss", () => {
    test("removes whitespace and newlines", async () => {
      const input = `
        .foo {
          color: red;
          margin: 10px;
        }
      `;
      const result = await minifyCss(input);
      // esbuild minifies CSS by removing unnecessary whitespace
      // Result may have trailing newline but no internal newlines
      expect(result.trim()).not.toContain("\n");
      expect(result).toContain(".foo");
      expect(result).toContain("color:");
      expect(result).toContain("red");
    });

    test("removes comments", async () => {
      const input = `
        /* This is a comment */
        .bar { color: blue; }
      `;
      const result = await minifyCss(input);
      expect(result).not.toContain("comment");
      expect(result).toContain(".bar");
    });

    test("shortens color values where possible", async () => {
      const input = ".test { color: #ffffff; }";
      const result = await minifyCss(input);
      // esbuild may shorten #ffffff to #fff
      expect(result).toMatch(/#fff(?:fff)?/);
    });

    test("preserves valid CSS syntax", async () => {
      const input = `
        :root {
          --color-primary: #791a81;
        }
        .btn {
          background: var(--color-primary);
          padding: 1rem 2rem;
        }
      `;
      const result = await minifyCss(input);
      expect(result).toContain("--color-primary");
      expect(result).toContain("var(--color-primary)");
    });

    test("handles empty input", async () => {
      const result = await minifyCss("");
      expect(result).toBe("");
    });

    test("handles media queries", async () => {
      const input = `
        @media (max-width: 768px) {
          .mobile { display: block; }
        }
      `;
      const result = await minifyCss(input);
      expect(result).toContain("@media");
      expect(result).toContain("max-width:");
      expect(result).toContain("768px");
      expect(result).toContain(".mobile");
    });
  });
});
