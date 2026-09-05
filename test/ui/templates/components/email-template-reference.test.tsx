import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";

describe("email template reference declaration", () => {
  test("declares each code once", () => {
    const codes = TEMPLATE_VARIABLES.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
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
