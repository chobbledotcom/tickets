import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import { fromBase64, toBase64 } from "#crypto/utils.ts";
import {
  compareFingerprints,
  FINGERPRINT_SIZE,
  fingerprintPng,
  freshnessPercent,
  type GuideFingerprint,
} from "#scripts/guides/fingerprint.ts";
import { sha256Hex } from "#shared/sha256.ts";

const png = async (grey: number): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        background: { b: grey, g: grey, r: grey },
        channels: 3,
        height: 16,
        width: 16,
      },
    })
      .png()
      .toBuffer(),
  );

const fingerprintWith = async (
  grey: number,
  sha256: string,
): Promise<GuideFingerprint> => ({
  grayscale: toBase64(
    new Uint8Array(FINGERPRINT_SIZE * FINGERPRINT_SIZE).fill(grey),
  ),
  sha256,
});

describe("guide screenshot fingerprint", () => {
  test("fingerprints a PNG and keeps its exact digest", async () => {
    const bytes = await png(32);
    const fingerprint = await fingerprintPng(bytes);

    expect(fingerprint.sha256).toBe(await sha256Hex(bytes));
    expect(fromBase64(fingerprint.grayscale).length).toBe(
      FINGERPRINT_SIZE * FINGERPRINT_SIZE,
    );
  });

  test("scores identical files as one and inverted files as zero", async () => {
    const black = await fingerprintPng(await png(0));
    const white = await fingerprintPng(await png(255));
    const half = await fingerprintWith(128, "b".repeat(64));

    expect(compareFingerprints(black, black)).toBe(1);
    expect(compareFingerprints(black, white)).toBeCloseTo(0, 6);
    expect(compareFingerprints(black, half)).toBeCloseTo(0.5, 2);
    expect(freshnessPercent(0.876)).toBe(88);
  });

  test("keeps a moved layout apart from a small change", async () => {
    const pattern = (offset: number, sha: string): GuideFingerprint => {
      const bytes = new Uint8Array(FINGERPRINT_SIZE * FINGERPRINT_SIZE).fill(
        255,
      );
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          bytes[y * FINGERPRINT_SIZE + x + offset] = 0;
        }
      }
      return { grayscale: toBase64(bytes), sha256: sha.repeat(64) };
    };
    const original = pattern(0, "a");
    const moved = pattern(12, "b");
    const nudged = pattern(1, "c");

    const movedScore = compareFingerprints(original, moved);
    const nudgedScore = compareFingerprints(original, nudged);
    expect(movedScore).toBeLessThan(0.8);
    expect(nudgedScore).toBeGreaterThan(0.9);
  });

  test("prefers the exact digest over the grey thumbnail", async () => {
    const left = await fingerprintWith(0, "a".repeat(64));
    const right = await fingerprintWith(255, "a".repeat(64));

    expect(compareFingerprints(left, right)).toBe(1);
  });

  test("rejects a thumbnail that is the wrong size", async () => {
    const broken = {
      grayscale: toBase64(new Uint8Array(4)),
      sha256: "a".repeat(64),
    };
    const valid = await fingerprintWith(0, "b".repeat(64));
    expect(() => compareFingerprints(broken, valid)).toThrow(
      "must hold 1024 bytes",
    );
  });
});
