import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { openSection } from "#templates/components/open-section.tsx";

describe("openSection", () => {
  test("puts the heading in a summary and the body under it", () => {
    expect(openSection("Upcoming", <p>Nothing yet</p>)).toBe(
      "<details open><summary>Upcoming</summary><p>Nothing yet</p></details>",
    );
  });

  test("escapes a heading that carries markup characters", () => {
    assertStringIncludes(
      openSection("A & B", ""),
      "<summary>A &amp; B</summary>",
    );
  });
});
