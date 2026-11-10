import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { UNREAD_FIELD_EXEMPTION_RULES } from "#scripts/unread-fields/exemptions.ts";
import { ownerKey } from "#scripts/unread-fields/identity.ts";

describe("unread-field exemption rules", () => {
  test("names each owner path once, so no field gains two reasons", () => {
    const keys = UNREAD_FIELD_EXEMPTION_RULES.map((rule) =>
      ownerKey(rule.exportedFrom, rule.path),
    );

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("names a reported file and production evidence for every rule", () => {
    expect(
      UNREAD_FIELD_EXEMPTION_RULES.filter(
        ({ exportedFrom, reason }) =>
          !exportedFrom.startsWith("src/") || reason.evidence.trim() === "",
      ),
    ).toEqual([]);
  });
});
