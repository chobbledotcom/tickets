import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { guideEvidenceDeclarations } from "#scripts/guides/evidence-cases.ts";
import {
  type GuideStoryboard,
  storyboardEvidence,
} from "#scripts/guides/storyboard.ts";
import { GUIDE_STORYBOARDS } from "#scripts/guides/storyboards/index.ts";
import { EVIDENCE_CAPTURES } from "#scripts/specs/evidence/declarations.ts";
import {
  type EvidenceCaptureDeclaration,
  EvidenceCaptureDeclarationSchema,
} from "#scripts/specs/evidence/schema.ts";

const declaration = (id: string, caseId: string): EvidenceCaptureDeclaration =>
  v.parse(EvidenceCaptureDeclarationSchema, {
    caseId,
    element: "main",
    id,
    presentation: "canonical",
    profiles: ["desktop"],
  });

const storyboard = (captureId: string, caseId: string): GuideStoryboard => ({
  actions: [{ captureId, caseId, kind: "evidence" }],
  fps: 30,
  setup: [],
  slug: "test-guide",
  title: "Test guide",
});

describe("guide evidence declarations", () => {
  test("keeps every capture of a case that a guide uses", () => {
    const declarations = [
      declaration("first", "guide.case"),
      declaration("second", "guide.case"),
      declaration("other", "other.case"),
    ];

    expect(
      guideEvidenceDeclarations(declarations, [
        storyboard("first", "guide.case"),
      ]),
    ).toEqual([declarations[0], declarations[1]]);
  });

  for (const [captureId, caseId, message] of [
    [
      "missing",
      "guide.case",
      "Guide test-guide names the evidence capture missing, which does not exist.",
    ],
    [
      "first",
      "other.case",
      "Guide test-guide names the evidence capture first for other.case, but it belongs to guide.case.",
    ],
  ] as const) {
    test(`throws for ${captureId}`, () => {
      expect(() =>
        guideEvidenceDeclarations(
          [declaration("first", "guide.case")],
          [storyboard(captureId, caseId)],
        ),
      ).toThrow(message);
    });
  }

  test("selects the evidence that the real guides use", () => {
    const selected = guideEvidenceDeclarations(
      EVIDENCE_CAPTURES,
      GUIDE_STORYBOARDS,
    );
    const guideCases = new Set(
      GUIDE_STORYBOARDS.flatMap(storyboardEvidence).map(({ caseId }) => caseId),
    );

    const ids = selected.map(({ id }) => id);
    expect(ids).toContain("listing-form");
    expect(ids).toContain("public-booking-page");
    expect(ids).not.toContain("free-headcount-no-money");
    expect([...new Set(selected.map(({ caseId }) => caseId))].sort()).toEqual(
      [...guideCases].sort(),
    );
  });
});
