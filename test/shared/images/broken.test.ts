import { inflateSync } from "node:zlib";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import {
  BROKEN_IMAGE_FILENAME,
  BROKEN_IMAGE_PNG,
  decryptImageFilename,
  decryptImageFilenameOrEmpty,
} from "#shared/images/broken.ts";
import { getMimeTypeFromFilename } from "#shared/storage.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

/** Read a big-endian 32-bit number out of the PNG bytes. */
const pngNumberAt = (offset: number): number =>
  new DataView(BROKEN_IMAGE_PNG.buffer, BROKEN_IMAGE_PNG.byteOffset).getUint32(
    offset,
  );

describe("images > broken image fallback", () => {
  describe("the red pixel", () => {
    test("marker filename maps to the PNG content type", () => {
      expect(getMimeTypeFromFilename(BROKEN_IMAGE_FILENAME)).toBe("image/png");
    });

    test("bytes are a valid 1x1 PNG", () => {
      expect([...BROKEN_IMAGE_PNG.slice(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      // IHDR: width and height 1, 8-bit depth, color type 2 (plain RGB).
      expect(pngNumberAt(16)).toBe(1);
      expect(pngNumberAt(20)).toBe(1);
      expect(BROKEN_IMAGE_PNG[24]).toBe(8);
      expect(BROKEN_IMAGE_PNG[25]).toBe(2);
    });

    test("pixel is pure red", () => {
      // The IDAT chunk holds the one deflated scanline: filter byte 0, then
      // the RGB bytes — red means exactly [255, 0, 0].
      const marker = new TextEncoder().encode("IDAT");
      const dataStart = BROKEN_IMAGE_PNG.findIndex((_, index) =>
        marker.every((byte, i) => BROKEN_IMAGE_PNG[index + i] === byte),
      );
      const length = pngNumberAt(dataStart - 4);
      const scanline = inflateSync(
        BROKEN_IMAGE_PNG.slice(dataStart + 4, dataStart + 4 + length),
      );
      expect([...new Uint8Array(scanline)]).toEqual([0, 255, 0, 0]);
    });
  });

  describeWithEnv("filename reads", { encryptionKey: true }, () => {
    const errors = setupErrorSpy();

    test("returns a readable filename unchanged without reporting", async () => {
      const stored = await encrypt("hero.webp");
      expect(await decryptImageFilename(stored, "image 1 filename")).toBe(
        "hero.webp",
      );
      expect(errors.calls.length).toBe(0);
    });

    test("falls back and reports when the filename decrypts to empty", async () => {
      const stored = await encrypt("");
      expect(await decryptImageFilename(stored, "image 2 filename")).toBe(
        BROKEN_IMAGE_FILENAME,
      );
      expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
      expect(errors.lastMessage()).toContain(
        "image 2 filename decrypted to an empty value",
      );
    });

    test("falls back and reports when the filename will not decrypt", async () => {
      expect(await decryptImageFilename("garbage", "image 3 filename")).toBe(
        BROKEN_IMAGE_FILENAME,
      );
      expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
      expect(errors.lastMessage()).toContain(
        "image 3 filename could not be decrypted",
      );
      expect(errors.lastMessage()).toContain("Invalid encrypted data format");
    });

    test("treats an empty or missing projection as no image, not broken", async () => {
      expect(await decryptImageFilenameOrEmpty("", "listing 4 image")).toBe("");
      expect(
        await decryptImageFilenameOrEmpty(undefined, "listing 4 image"),
      ).toBe("");
      expect(errors.calls.length).toBe(0);
    });

    test("routes a non-empty projection through the broken fallback", async () => {
      expect(
        await decryptImageFilenameOrEmpty(
          await encrypt("poster.webp"),
          "listing 5 image",
        ),
      ).toBe("poster.webp");
      expect(
        await decryptImageFilenameOrEmpty(await encrypt(""), "listing 5 image"),
      ).toBe(BROKEN_IMAGE_FILENAME);
      expect(errors.lastMessage()).toContain(
        "listing 5 image decrypted to an empty value",
      );
    });
  });
});
