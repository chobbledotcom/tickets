import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decrypt } from "#shared/crypto/encryption.ts";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import { openNote, openNotes, sealNote } from "#shared/db/notes/sealing.ts";
import type { SystemNoteRow } from "#shared/db/notes/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const row = <Type extends "owner" | "system">(
  type: Type,
  note: string,
  id = 1,
): SystemNoteRow =>
  ({
    created: "2026-07-28T10:00:00.000Z",
    entity_id: 4,
    entity_type: "attendee",
    id,
    note,
    type,
  }) as SystemNoteRow;

describeWithEnv("db > notes > sealing", { db: true }, () => {
  describe("sealing a note", () => {
    test("seals a system note so the data key alone opens it", async () => {
      const sealed = await sealNote("system", "system secret");

      expect(sealed.startsWith("enc:")).toBe(true);
      expect(sealed).not.toContain("system secret");
      expect(await decrypt(sealed as EnvKeyEncrypted)).toBe("system secret");
    });

    test("seals an owner note so only the owner key opens it", async () => {
      const sealed = await sealNote("owner", "owner secret");

      expect(sealed.startsWith("hyb:")).toBe(true);
      expect(sealed).not.toContain("owner secret");
      expect(
        await decryptWithOwnerKey(
          sealed as OwnerKeyEncrypted,
          await getTestPrivateKey(),
        ),
      ).toBe("owner secret");
    });
  });

  describe("opening a note", () => {
    test("opens each kind the way it was sealed", async () => {
      const sealed = [
        row("system", await sealNote("system", "from the app"), 1),
        row("owner", await sealNote("owner", "from the operator"), 2),
      ];

      const opened = await openNotes(sealed, await getTestPrivateKey());

      expect(opened.map((note) => note.note)).toEqual([
        "from the app",
        "from the operator",
      ]);
    });

    test("keeps everything about the note except its sealed text", async () => {
      const sealed = row("system", await sealNote("system", "kept"), 12);

      const opened = await openNote(sealed, await getTestPrivateKey());

      expect(opened).toEqual({ ...sealed, note: "kept" });
    });

    test("opens a batch in the order it was given", async () => {
      const sealed = await Promise.all(
        ["first", "second", "third"].map(async (text, index) =>
          row("system", await sealNote("system", text), index + 1),
        ),
      );

      const opened = await openNotes(sealed, await getTestPrivateKey());

      expect(opened.map((note) => note.note)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    test("opens nothing when given nothing", async () => {
      expect(await openNotes([], await getTestPrivateKey())).toEqual([]);
    });
  });
});
