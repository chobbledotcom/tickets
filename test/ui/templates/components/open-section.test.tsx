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
    expect(openSection("A & B", "")).toContain("<summary>A &amp; B</summary>");
  });
});
