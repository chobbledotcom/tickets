import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isAllowedEvidenceRequest,
  resolveEvidencePath,
} from "#scripts/specs/evidence/browser.ts";

describe("Cucumber evidence browser boundary", () => {
  test("fills encoded World values into a declared path", () => {
    expect(
      resolveEvidencePath(
        "/admin/servicing/{servicingEventId}/{label}",
        new Map([
          ["servicingEventId", "42"],
          ["label", "floor treatment"],
        ]),
      ),
    ).toBe("/admin/servicing/42/floor%20treatment");
  });

  test("fails when a declared path value was not set by the scenario", () => {
    expect(() =>
      resolveEvidencePath("/admin/servicing/{servicingEventId}", new Map()),
    ).toThrow("Evidence World value servicingEventId was not set");
  });

  test("allows only the scenario server and inline data", () => {
    const baseUrl = "http://127.0.0.1:3100";
    expect(isAllowedEvidenceRequest(baseUrl, `${baseUrl}/admin/`)).toBe(true);
    expect(
      isAllowedEvidenceRequest(baseUrl, "data:image/png;base64,AAAA"),
    ).toBe(true);
    expect(
      isAllowedEvidenceRequest(baseUrl, "https://example.com/font.woff2"),
    ).toBe(false);
  });
});
