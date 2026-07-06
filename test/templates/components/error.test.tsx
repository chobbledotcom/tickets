/**
 * Tests for the two error-box components (`src/ui/templates/components/error.tsx`).
 *
 * `ErrorAlert` is a live error — focusable (so the browser scrolls to it) and
 * announced. `ErrorNote` is a standing note — calm, never a focus target.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorAlert, ErrorNote } from "#templates/components/error.tsx";

describe("ErrorAlert", () => {
  test("renders a focusable, announced alert around its children", () => {
    const html = String(ErrorAlert({ children: "Something went wrong" }));
    // role="alert" is announced + matches the fade-in keyframe; autofocus +
    // tabindex="-1" make it the browser's scroll-to-error target.
    expect(html).toBe(
      `<div autofocus class="error" role="alert" tabindex="-1">Something went wrong</div>`,
    );
  });
});

describe("ErrorNote", () => {
  test("renders a calm error-styled note that is not a live alert", () => {
    const html = String(ErrorNote({ children: "A standing caution" }));
    expect(html).toBe(`<div class="error">A standing caution</div>`);
    // Never announced assertively, animated, or focused.
    expect(html).not.toContain("role=");
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain("tabindex");
  });
});
