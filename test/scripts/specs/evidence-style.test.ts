import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { storeEvidenceCss } from "#scripts/specs/evidence/style.ts";

describe("Cucumber evidence style", () => {
  test("stores capture CSS for the production page instead of injecting it past CSP", async () => {
    const writes: string[] = [];
    await storeEvidenceCss(
      { element: "#form" },
      "#form { color: navy; }",
      (css: string) => {
        writes.push(css);
        return Promise.resolve();
      },
    );

    expect(writes).toHaveLength(1);
    assertStringIncludes(writes[0] ?? "", "#form { color: navy; }");
    assertStringIncludes(writes[0] ?? "", ":is(#form), :is(#form) *");
    assertStringIncludes(writes[0] ?? "", "animation: none !important");
  });

  test("stores isolation and deterministic rules without optional branding", async () => {
    let stored = "not written";
    await storeEvidenceCss({ element: "#form" }, "", (css: string) => {
      stored = css;
      return Promise.resolve();
    });

    expect(stored.startsWith("\nbody *")).toBe(true);
    assert(!stored.includes("undefined"));
  });
});
