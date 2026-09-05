import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";

describe("email template reference declaration", () => {
  test("declares each code once", () => {
    const codes = TEMPLATE_VARIABLES.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("every variable shows a Liquid code and a catalog description", () => {
    for (const [code, key] of TEMPLATE_VARIABLES) {
      expect(code, key).toMatch(/^\{\{ .+ \}\}$/);
      expect(t(`settings.advanced.email_variables.${key}`), code).not.toBe("");
    }
  });

  test("the worked loop uses only variables the table declares", () => {
    const declared = TEMPLATE_VARIABLES.map(([code]) =>
      code
        .replace(/^\{\{\s*|\s*\}\}$/g, "")
        .split("|")[0]!
        .trim(),
    );
    const used = [...LOOP_EXAMPLE.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(
      (match) => match[1]!.split("|")[0]!.trim(),
    );
    for (const path of used) expect(declared).toContain(path);
  });
});
