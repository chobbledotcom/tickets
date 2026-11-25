import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  EDGE_HASH_PATTERN,
  edgeHash,
  edgeSimilarity,
  freshnessPercent,
  THUMBNAIL_SIDE,
} from "#scripts/guides/edge-hash.ts";
import { fingerprintPng } from "#scripts/guides/fingerprint.ts";
import { hashOf } from "./fixtures.ts";

const NO_EDGES = hashOf("");

/** A white thumbnail with a black block, 8 pixels square, at one place. */
const blockAt = (left: number, top: number): Uint8Array => {
  const bytes = new Uint8Array(THUMBNAIL_SIDE * THUMBNAIL_SIDE).fill(255);
  for (let y = top; y < top + 8; y += 1) {
    bytes.fill(0, y * THUMBNAIL_SIDE + left, y * THUMBNAIL_SIDE + left + 8);
  }
  return bytes;
};

describe("guide edge hash", () => {
  test("marks the cell left of each dark block on every row it covers", () => {
    // The block covers grid columns 1 and 2 on grid rows 0 to 3. Column 0 is
    // brighter than column 1, so bit 0 of each 15-bit row is set.
    const bits = [...edgeHash(blockAt(2, 0))]
      .flatMap((digit) =>
        [...Number.parseInt(digit, 16).toString(2).padStart(4, "0")].map(
          Number,
        ),
      )
      .flatMap((bit, index) => (bit === 1 ? [index] : []));
    expect(bits).toEqual([0, 15, 30, 45]);
  });

  test("reads a flat page as a page without edges", async () => {
    const png = new Uint8Array(
      await sharp({
        create: {
          background: { b: 32, g: 32, r: 32 },
          channels: 3,
          height: 72,
          width: 128,
        },
      })
        .png()
        .toBuffer(),
    );
    const hash = await fingerprintPng(png);
    expect(hash).toBe(NO_EDGES);
    expect(EDGE_HASH_PATTERN.test(hash)).toBe(true);
  });

  test("scores the share of edges both pages hold", () => {
    expect(
      [
        [hashOf("f"), hashOf("f")],
        [hashOf("f"), hashOf("0f")],
        [hashOf("f"), hashOf("3")],
        [NO_EDGES, NO_EDGES],
      ].map(([left, right]) => edgeSimilarity(left!, right!)),
    ).toEqual([1, 0, 0.5, 1]);
    expect(freshnessPercent(0.876)).toBe(88);
  });

  test("scores a nudged block between a match and a moved one", () => {
    const original = edgeHash(blockAt(2, 0));
    // One pixel right, the block half fills a cell, which adds a second edge.
    const nudged = edgeHash(blockAt(3, 0));
    const moved = edgeHash(blockAt(2, 16));
    expect(
      [original, nudged, moved].map((hash) => edgeSimilarity(original, hash)),
    ).toEqual([1, 0.5, 0]);
  });

  test("refuses a thumbnail of the wrong size and a malformed hash", () => {
    expect(() => edgeHash(new Uint8Array(4))).toThrow(
      "An edge hash needs 1024 thumbnail bytes, not 4",
    );
    expect(() => edgeSimilarity("abc", NO_EDGES)).toThrow(
      "Invalid edge hash abc",
    );
  });
});
