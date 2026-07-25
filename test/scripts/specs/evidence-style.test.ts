import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { storeEvidenceCss } from "#scripts/specs/evidence/style.ts";

describe("Cucumber evidence style", () => {
  test("stores capture CSS for the production page instead of injecting it past CSP", async () => {
    const writes: string[] = [];
    await storeEvidenceCss(
      { css: "#form { color: navy; }", element: "#form" },
      (css) => {
        writes.push(css);
        return Promise.resolve();
      },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("#form { color: navy; }");
    expect(writes[0]).toContain(":is(#form), :is(#form) *");
    expect(writes[0]).toContain("animation: none !important");
  });

  test("stores isolation and deterministic rules without optional branding", async () => {
    let stored = "not written";
    await storeEvidenceCss({ element: "#form" }, (css) => {
      stored = css;
      return Promise.resolve();
    });

    expect(stored.startsWith("\nbody *")).toBe(true);
    expect(stored).not.toContain("undefined");
  });
});
