/**
 * The ENCB header a stored file carries: a wrong offset or version here writes
 * files the next release cannot read back, so the layout is asserted directly
 * rather than only through the image and attachment routes that use it.
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { decryptBytes, encryptBytes } from "#shared/crypto/encryption.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The layout the format promises: "ENCB", version 1, then a 12-byte IV. */
const MAGIC = [0x45, 0x4e, 0x43, 0x42];
const VERSION_OFFSET = MAGIC.length;
const IV_OFFSET = VERSION_OFFSET + 1;
const HEADER_SIZE = IV_OFFSET + 12;

const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describeWithEnv("encryptBytes / decryptBytes", { encryptionKey: true }, () => {
  describe("the header it writes", () => {
    it("starts with the ENCB magic bytes", async () => {
      const sealed = await encryptBytes(plain);
      expect([...sealed.slice(0, MAGIC.length)]).toEqual(MAGIC);
    });

    it("declares format version 1", async () => {
      const sealed = await encryptBytes(plain);
      expect(sealed[VERSION_OFFSET]).toBe(1);
    });

    it("gives every sealed file its own IV, in the header's IV slot", async () => {
      const sealed = await encryptBytes(plain);
      // A fresh IV every time is what keeps two identical files from sealing
      // to identical bytes.
      const other = await encryptBytes(plain);
      expect([...sealed.slice(IV_OFFSET, HEADER_SIZE)]).not.toEqual([
        ...other.slice(IV_OFFSET, HEADER_SIZE),
      ]);
    });

    it("adds exactly the header plus the GCM tag to the data's size", async () => {
      const sealed = await encryptBytes(plain);
      // 17-byte header + 16-byte GCM tag: the documented 33 bytes of overhead.
      expect(sealed.length).toBe(plain.length + 33);
    });

    it("does not leave the data readable in the sealed bytes", async () => {
      const sealed = await encryptBytes(plain);
      // Same length as the data, so this compares like with like: a body that
      // passed the plaintext straight through would match here.
      const body = sealed.slice(HEADER_SIZE, HEADER_SIZE + plain.length);
      expect([...body]).not.toEqual([...plain]);
    });
  });

  describe("reading the bytes back", () => {
    it("returns exactly what was sealed", async () => {
      expect([...(await decryptBytes(await encryptBytes(plain)))]).toEqual([
        ...plain,
      ]);
    });

    it("round-trips data with no bytes in it", async () => {
      const sealed = await encryptBytes(new Uint8Array());
      expect(sealed.length).toBe(33);
      expect((await decryptBytes(sealed)).length).toBe(0);
    });

    it("round-trips data larger than one block", async () => {
      const big = crypto.getRandomValues(new Uint8Array(5000));
      expect([...(await decryptBytes(await encryptBytes(big)))]).toEqual([
        ...big,
      ]);
    });
  });

  describe("bytes it refuses", () => {
    /** Seal `plain`, then change one byte of the header. */
    const sealedWithByteChanged = async (
      offset: number,
      value: number,
    ): Promise<Uint8Array> => {
      const sealed = await encryptBytes(plain);
      sealed[offset] = value;
      return sealed;
    };

    for (const offset of [0, 1, 2, 3]) {
      it(`rejects bytes whose magic is wrong at position ${offset}`, async () => {
        await expect(
          decryptBytes(await sealedWithByteChanged(offset, 0x00)),
        ).rejects.toThrow("Invalid binary encryption format");
      });
    }

    it("rejects a version it does not know, naming the version", async () => {
      await expect(
        decryptBytes(await sealedWithByteChanged(VERSION_OFFSET, 0x02)),
      ).rejects.toThrow("Unsupported binary encryption version: 2");
    });

    it("rejects bytes too short to hold a header", async () => {
      const truncated = (await encryptBytes(plain)).slice(0, HEADER_SIZE - 1);
      await expect(decryptBytes(truncated)).rejects.toThrow(
        "Invalid binary encryption format",
      );
    });

    it("rejects a well-formed header with no ciphertext after it", async () => {
      const headerOnly = (await encryptBytes(plain)).slice(0, HEADER_SIZE);
      // The header passes both checks, so this proves the failure comes from
      // the decryption itself rather than from the format guards.
      await expect(decryptBytes(headerOnly)).rejects.not.toThrow(
        "Invalid binary encryption format",
      );
    });

    it("rejects data whose ciphertext was tampered with", async () => {
      const sealed = await encryptBytes(plain);
      sealed[HEADER_SIZE]! ^= 0xff;
      await expect(decryptBytes(sealed)).rejects.toThrow();
    });

    it("rejects data whose IV was tampered with", async () => {
      const sealed = await encryptBytes(plain);
      sealed[IV_OFFSET]! ^= 0xff;
      await expect(decryptBytes(sealed)).rejects.toThrow();
    });
  });
});
