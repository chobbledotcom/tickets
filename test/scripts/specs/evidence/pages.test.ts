import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { EvidenceCaptureId } from "#scripts/specs/evidence/declarations.ts";
import {
  type EvidencePages,
  evidencePagePath,
  leaveEvidencePage,
} from "#scripts/specs/evidence/pages.ts";
import { PAYMENT_RESULT_CAPTURE as declaration } from "#test/scripts/specs/evidence-fixture.ts";

const emptyWorld = (): EvidencePages => ({
  evidenceCookies: new Map<EvidenceCaptureId, string>(),
  evidencePages: new Map<EvidenceCaptureId, string>(),
});

describe("Evidence pages a story leaves", () => {
  test("names every capture the one page is for", () => {
    const world = emptyWorld();

    leaveEvidencePage(
      world,
      ["contact-record", "record-put-right"],
      "/admin/history/abc123",
    );

    expect([...world.evidencePages]).toEqual([
      ["contact-record", "/admin/history/abc123"],
      ["record-put-right", "/admin/history/abc123"],
    ]);
  });

  test("keeps the page a later step left instead of the earlier one", () => {
    const world = emptyWorld();

    leaveEvidencePage(world, ["listing-ledger"], "/admin/ledger/revenue/1");
    leaveEvidencePage(world, ["listing-ledger"], "/admin/ledger/revenue/2");

    expect(world.evidencePages.get("listing-ledger")).toBe(
      "/admin/ledger/revenue/2",
    );
  });

  test("keeps the session the story left for a capture", () => {
    const world = emptyWorld();

    leaveEvidencePage(
      world,
      ["listing-ledger"],
      "/admin/ledger/revenue/1",
      "session=editor",
    );

    expect(world.evidenceCookies.get("listing-ledger")).toBe("session=editor");
  });

  test("refuses a page that is not a whole address", () => {
    for (const path of ["admin/settings", "/ticket/{bundleSlug}", ""]) {
      expect(() =>
        leaveEvidencePage(emptyWorld(), ["listing-ledger"], path),
      ).toThrow();
    }
  });

  test("accepts an HTML data page for a downloaded outcome", () => {
    const world = emptyWorld();
    const page = "data:text/html,%3Cmain%3ECSV%3C%2Fmain%3E";

    leaveEvidencePage(world, ["listing-ledger"], page);

    expect(world.evidencePages.get("listing-ledger")).toBe(page);
  });

  test("opens the address the declaration fixes, ignoring what was left", () => {
    expect(
      evidencePagePath(
        { ...declaration, path: "/admin/settings" },
        new Map([[declaration.id, "/admin/payments/42"]]),
      ),
    ).toBe("/admin/settings");
  });

  test("opens the page the story left when the declaration fixes none", () => {
    expect(
      evidencePagePath(
        declaration,
        new Map([[declaration.id, "/admin/payments/42"]]),
      ),
    ).toBe("/admin/payments/42");
  });

  test("fails when the story reached no page for the capture", () => {
    expect(() => evidencePagePath(declaration, new Map())).toThrow(
      "The story left no page for the payment-result capture",
    );
  });
});
