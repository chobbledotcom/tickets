// Property tests for the signed QR booking tokens: sign∘verify round trips
// for arbitrary payloads, totality of verify on arbitrary token strings,
// domain separation across slugs, and tamper rejection. fast-check runs each
// property with a fixed seed and run count, so every run generates the same
// cases.
import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import * as fc from "fast-check";
import { base64ToBase64Url, fromBase64Url, toBase64 } from "#crypto/utils.ts";
import {
  buildQrBookPayload,
  type QrBookPayload,
  signQrBookToken,
  verifyQrBookToken,
} from "#shared/qr-token.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

/** The fixed epoch every property runs at: the builder stamps the token's
 * expiry from the clock and verify reads the clock again, so both reads must
 * land on the same frozen instant for a run to reproduce. */
const FROZEN_EPOCH_MS = 1_700_000_000_000;

/** Hold the clock at the fixed epoch while one property runs. */
const withFrozenClock = async (run: () => Promise<void>): Promise<void> => {
  using _time = new FakeTime(FROZEN_EPOCH_MS);
  await run();
};

const arbitraryPayload = (): fc.Arbitrary<QrBookPayload> =>
  fc
    .record({
      date: fc
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
    await withFrozenClock(() =>
      fc.assert(
        fc.asyncProperty(
          arbitrarySlug,
          arbitraryPayload(),
          async (slug, payload) => {
            const token = await signQrBookToken(slug, payload);
            const verified = await verifyQrBookToken(slug, token);
            expect(verified).toEqual(payload);
          },
        ),
        seedArgs,
      ),
    );
  });

  test("verify is total on arbitrary token strings", async () => {
    await withFrozenClock(() =>
      fc.assert(
        fc.asyncProperty(
          arbitrarySlug,
          fc.string({ maxLength: 200 }),
          async (slug, token) => {
            const verified = await verifyQrBookToken(slug, token);
            expect(verified === null || typeof verified === "object").toBe(
              true,
            );
          },
        ),
        seedArgs,
      ),
    );
  });

  test("a token signed for one slug never verifies against another", async () => {
    await withFrozenClock(() =>
      fc.assert(
        fc.asyncProperty(
          arbitrarySlug,
          arbitraryPayload(),
          fc.string({ maxLength: 40 }),
          async (slug, payload, other) => {
            const token = await signQrBookToken(slug, payload);
            if (other === slug) return;
            expect(await verifyQrBookToken(other, token)).toBeNull();
          },
        ),
        seedArgs,
      ),
    );
  });

  test("a flipped character anywhere in the token rejects it", async () => {
    await withFrozenClock(() =>
      fc.assert(
        fc.asyncProperty(
          arbitrarySlug,
          arbitraryPayload(),
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
      ),
    );
  });

  test("a tampered payload field without a re-sign rejects the token", async () => {
    await withFrozenClock(() =>
      fc.assert(
        fc.asyncProperty(
          arbitrarySlug,
          arbitraryPayload(),
          async (slug, payload) => {
            const token = await signQrBookToken(slug, payload);
            // The payload rides as base64url between the prefix and the HMAC:
            // swap the signed quantity field without re-signing, so the
            // signature no longer binds it.
            const [, encodedPayload, signature] = token.split(".");
            const decoded = JSON.parse(
              new TextDecoder().decode(fromBase64Url(encodedPayload!)),
            ) as QrBookPayload;
            const tamperedPayload = base64ToBase64Url(
              toBase64(
                new TextEncoder().encode(
                  JSON.stringify({ ...decoded, q: decoded.q + 1 }),
                ),
              ),
            );
            const tampered = `qr1.${tamperedPayload}.${signature}`;
            expect(await verifyQrBookToken(slug, tampered)).toBeNull();
          },
        ),
        seedArgs,
      ),
    );
  });
});
