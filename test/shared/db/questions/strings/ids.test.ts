import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { queryAll } from "#shared/db/client.ts";
import {
  getOrCreateStringIds,
  pairStringIds,
} from "#shared/db/questions/strings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("custom questions > shared strings", { db: true }, () => {
  describe("getOrCreateStringIds", () => {
    test("returns a complete map of real ids for brand-new texts", async () => {
      const texts = ["Wheelchair access", "Vegan meal", "Front row"];
      const ids = await getOrCreateStringIds(texts);

      // Every input text resolves to a distinct, positive-integer id with no
      // undefined slipping through. An undefined here is exactly what dropped
      // the `s` from a checkout's signed metadata and later made the webhook
      // bind an unsupported value, so this is the core read-your-writes guard.
      expect([...ids.keys()].sort()).toEqual([...texts].sort());
      // Distinct texts must resolve to distinct ids — no collision or reuse.
      expect(new Set(ids.values()).size).toBe(texts.length);

      // Each id must point at the row for that exact text, proven via the blind
      // index — this also proves every id is a real row id (not undefined or a
      // wrong number): a mutant id matches no row or a different text_index.
      for (const text of texts) {
        const rows = await queryAll<{ text_index: string }>(
          "SELECT text_index FROM strings WHERE id = ?",
          [ids.get(text)!],
        );
        expect(rows.length).toBe(1);
        expect(rows[0]!.text_index).toBe(await hmacHash(text));
      }
    });

    test("dedupes repeated input text to one id", async () => {
      const ids = await getOrCreateStringIds(["Same", "Same", "Same"]);
      expect([...ids.keys()]).toEqual(["Same"]);
      expect(Number.isInteger(ids.get("Same"))).toBe(true);
    });

    test("returns an empty map for no texts", async () => {
      const ids = await getOrCreateStringIds([]);
      expect(ids.size).toBe(0);
    });
  });
  describe("pairStringIds", () => {
    test("pairs each text with the id matching its text_index", () => {
      const rows = [
        { text: "alpha", textIndex: "idx-a" },
        { text: "beta", textIndex: "idx-b" },
      ];
      // Deliberately out of order to prove pairing is by index, not position.
      const found = [
        { id: 11, text_index: "idx-b" },
        { id: 7, text_index: "idx-a" },
      ];
      expect(pairStringIds(rows, found)).toEqual(
        new Map([
          ["alpha", 7],
          ["beta", 11],
        ]),
      );
    });

    test("throws naming the text_index when a written row is missing", () => {
      const rows = [{ text: "ghost", textIndex: "idx-missing" }];
      // A missing row is the read-your-writes failure that must fail loudly
      // rather than yield an undefined id callers would bind into SQL.
      expect(() => pairStringIds(rows, [])).toThrow("idx-missing");
    });

    test("returns an empty map for no rows", () => {
      expect(pairStringIds([], []).size).toBe(0);
    });
  });
});
