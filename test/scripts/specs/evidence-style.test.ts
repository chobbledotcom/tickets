import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { EVIDENCE_CAPTURES } from "#scripts/specs/evidence/declarations.ts";
import { storeEvidenceCss } from "#scripts/specs/evidence/style.ts";
import { requireValue } from "#shared/required-value.ts";

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

  test("sets every inherited base style used by each branded capture", async () => {
    const branded = EVIDENCE_CAPTURES.filter(
      ({ presentation }) => presentation === "branded",
    );
    expect(branded.length).toBeGreaterThan(1);
    for (const capture of branded) {
      let stored = "";
      await storeEvidenceCss(
        requireValue(capture, "Evidence capture is missing"),
        (css) => {
          stored = css;
          return Promise.resolve();
        },
      );

      for (const name of [
        "--border-radius",
        "--color-accent",
        "--color-bg",
        "--color-bg-secondary",
        "--color-link",
        "--color-secondary",
        "--color-secondary-accent",
        "--color-shadow",
        "--color-table",
        "--color-text",
        "--color-text-secondary",
        "--font-family",
      ]) {
        expect(stored).toContain(`${name}:`);
      }
    }
  });
});
