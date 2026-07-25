import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  EvidenceManifestSchema,
  evidenceTagExpression,
  parseEvidenceDeclarations,
} from "#scripts/specs/evidence/schema.ts";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import { requireValue } from "#shared/required-value.ts";
import { registry, source } from "#test/scripts/specs/profile-fixture.ts";

const catalog = validateSpecSources([source()], registry);

const declaration = {
  caseId: "payment.place-available",
  css: ":root { color-scheme: light; }",
  element: "#payment-result",
  id: "payment-result",
  path: "/admin/payments/{paymentId}",
  presentation: "canonical",
  profiles: ["mobile"],
} as const;

describe("Cucumber evidence schema", () => {
  test("validates declarations and selects their cases once", () => {
    const declarations = parseEvidenceDeclarations([declaration], catalog);

    expect(declarations).toEqual([declaration]);
    expect(evidenceTagExpression(declarations)).toBe(
      "@case:payment.place-available",
    );
  });

  test("sorts and deduplicates declared case selection", () => {
    const declarations = parseEvidenceDeclarations(
      [
        { ...declaration, id: "second-view", presentation: "editorial" },
        declaration,
      ],
      catalog,
    );

    expect(evidenceTagExpression(declarations)).toBe(
      "@case:payment.place-available",
    );
  });

  test("rejects invalid or duplicate capture declarations", () => {
    const invalid = [
      [[{ ...declaration, id: "Not Stable" }], "capture id"],
      [[{ ...declaration, path: "admin/payments" }], "path"],
      [[{ ...declaration, profiles: [] }], "profile"],
      [[{ ...declaration, profiles: ["mobile", "mobile"] }], "unique"],
      [[{ ...declaration, presentation: "sales" }], "canonical"],
      [
        [declaration, { ...declaration, caseId: "payment.other" }],
        "Duplicate evidence capture id payment-result",
      ],
      [[{ ...declaration, caseId: "payment.unknown" }], "Unknown @case"],
    ] as const;

    for (const [input, message] of invalid) {
      expect(() => parseEvidenceDeclarations(input, catalog)).toThrow(message);
    }
  });

  test("accepts only the versioned public manifest contract", () => {
    const manifest = {
      app: {
        commit: "a".repeat(40),
        repository: "chobbledotcom/tickets",
      },
      captures: [
        {
          assets: [
            {
              height: 200,
              mediaType: "image/png",
              path: "assets/payment-result--mobile.png",
              profile: "mobile",
              sha256: "b".repeat(64),
              viewport: {
                deviceScaleFactor: 2,
                height: 844,
                width: 390,
              },
              width: 300,
            },
          ],
          case: { id: "payment.place-available", name: "Payment succeeds" },
          id: "payment-result",
          presentation: "canonical",
          rule: {
            description: "A payment is accepted.",
            id: "payments.rule",
            name: "A payment succeeds",
          },
          steps: [{ keyword: "Given", text: "a payment is ready" }],
          story: {
            description: "Customers can pay.",
            id: "payments.story",
            name: "Customer payment",
          },
        },
      ],
      schemaVersion: 1,
    };

    expect(v.parse(EvidenceManifestSchema, manifest)).toEqual(manifest);
    expect(
      v.safeParse(EvidenceManifestSchema, {
        ...manifest,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(EvidenceManifestSchema, {
        ...manifest,
        app: { ...manifest.app, commit: "short" },
      }).success,
    ).toBe(false);

    const capture = requireValue(
      manifest.captures[0],
      "Manifest capture is missing",
    );
    const asset = requireValue(capture.assets[0], "Manifest asset is missing");
    const invalidCaptures = [
      [],
      [capture, { ...capture }],
      [{ ...capture, assets: [] }],
      [
        {
          ...capture,
          assets: [
            asset,
            { ...asset, path: "assets/payment-result-other.png" },
          ],
        },
      ],
      [{ ...capture, steps: [] }],
      [{ ...capture, steps: [{ keyword: "*", text: "anything happens" }] }],
      [
        capture,
        {
          ...capture,
          assets: [{ ...asset }],
          id: "other-capture",
        },
      ],
    ];
    for (const captures of invalidCaptures) {
      expect(
        v.safeParse(EvidenceManifestSchema, { ...manifest, captures }).success,
      ).toBe(false);
    }
  });
});
