// Property tests for the signed QR booking tokens: sign∘verify round trips
// for arbitrary payloads, totality of verify on arbitrary token strings,
// domain separation across slugs, and tamper rejection. fast-check runs each
// property with a fixed seed and run count, so every run generates the same
// cases.
import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import {
  buildQrBookPayload,
  signQrBookToken,
  verifyQrBookToken,
} from "#shared/qr-token.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

const arbitraryPayload = fc
  .record({
    d: fc
      .date({ max: new Date(2100, 0, 1), min: new Date(2020, 0, 1) })
      .map((date) => date.toISOString().slice(0, 10)),
    name: fc.string({ maxLength: 60 }),
    quantity: fc.integer({ max: 100, min: 1 }),
    value: fc.integer({ max: 1_000_000, min: -1 }),
  })
  .map((input) => buildQrBookPayload(input));

const arbitrarySlug = fc.string({ maxLength: 40 });

describe("qr token properties", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  test("verifies what it signed, for any payload and slug", async () => {
    fc.assert(
      fc.asyncProperty(
        arbitrarySlug,
        arbitraryPayload,
        async (slug, payload) => {
          const token = await signQrBookToken(slug, payload);
          const verified = await verifyQrBookToken(slug, token);
          expect(verified).toEqual(payload);
        },
      ),
      seedArgs,
    );
  });

  test("verify is total on arbitrary token strings", async () => {
    fc.assert(
      fc.asyncProperty(
        arbitrarySlug,
        fc.string({ maxLength: 200 }),
        async (slug, token) => {
          const verified = await verifyQrBookToken(slug, token);
          expect(verified === null || typeof verified === "object").toBe(true);
        },
      ),
      seedArgs,
    );
  });

  test("a token signed for one slug never verifies against another", async () => {
    fc.assert(
      fc.asyncProperty(
        arbitrarySlug,
        arbitraryPayload,
        fc.string({ maxLength: 40 }),
        async (slug, payload, other) => {
          const token = await signQrBookToken(slug, payload);
          if (other === slug) return;
          expect(await verifyQrBookToken(other, token)).toBeNull();
        },
      ),
      seedArgs,
    );
  });

  test("a flipped character anywhere in the signature rejects the token", async () => {
    fc.assert(
      fc.asyncProperty(
        arbitrarySlug,
        arbitraryPayload,
        fc.nat({ max: 40 }),
        async (slug, payload, offset) => {
          const token = await signQrBookToken(slug, payload);
          const position =
            token.length - 1 - (offset % Math.min(20, token.length));
          const original = token[position]!;
          const flipped = original === "A" ? "B" : "A";
          const tampered =
            token.slice(0, position) + flipped + token.slice(position + 1);
          expect(await verifyQrBookToken(slug, tampered)).toBeNull();
        },
      ),
      seedArgs,
    );
  });
});
