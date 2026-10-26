// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptPiiBlob } from "#db/attendees/pii.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { updateAttendeePII } from "#db/attendees/update.ts";
import { queryOne } from "#db/client.ts";
import { contactHash, forgetContact } from "#db/contact-preferences.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { mergePair, submitMerge } from "#test-utils/attendees/merge.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { attendeePiiOf } from "#test-utils/db-helpers/attendee-payments.ts";
import type { Attendee } from "#types";

// jscpd:ignore-end

/** Pin an attendee at the given coordinates through the real edit path. */
const pinAttendee = async (
  attendee: Attendee,
  lat: string,
  lng: string,
): Promise<void> =>
  updateAttendeePII(attendee.id, { ...attendeePiiOf(attendee), lat, lng });

/** Read the merged target's decrypted contact fields by its ticket token. */
const piiOfToken = async (token: string) => {
  const [row] = await getAttendeesByTokens([token]);
  if (!row) throw new Error("The merged attendee's token no longer resolves");
  return decryptPiiBlob(row.pii_blob, await getTestPrivateKey(), true);
};

/** The number of contact records stored for one contact hash. */
const contactRows = async (hash: string): Promise<number> => {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row!.n;
};

describeWithEnv(
  "server (admin attendees) > merge pinned location",
  { db: true },
  () => {
    /** Merge a pair whose sides carry the given addresses and pins, keeping
     *  `keep`'s address (the target by default), and return the surviving
     *  lat/lng. The pin-follow scenarios all share this shape. */
    const mergePins = async (opts: {
      sourceAddress: string;
      targetAddress: string;
      sourcePin?: [string, string];
      targetPin?: [string, string];
      keep?: "source" | "target";
    }): Promise<{ lat: string; lng: string }> => {
      const { source, sourceToken, target } = await mergePair({
        source: { address: opts.sourceAddress },
        target: { address: opts.targetAddress },
      });
      if (opts.sourcePin) await pinAttendee(source, ...opts.sourcePin);
      if (opts.targetPin) await pinAttendee(target, ...opts.targetPin);
      const { response } = await submitMerge(
        target.id,
        sourceToken,
        opts.keep === "source" ? { pii_address: "source" } : {},
      );
      expectFlash(response, expect.stringContaining("Merged"), true);
      return piiOfToken(target.ticket_token);
    };

    test("keeping the source address keeps the source's pin", async () => {
      const pii = await mergePins({
        keep: "source",
        sourceAddress: "1 Source Road",
        sourcePin: ["52.1", "-1.2"],
        targetAddress: "9 Target Road",
        targetPin: ["53.5", "0.1"],
      });
      expect(pii.lat).toBe("52.1");
      expect(pii.lng).toBe("-1.2");
    });

    test("an identical address keeps the other side's only pin (source kept)", async () => {
      const pii = await mergePins({
        keep: "source",
        sourceAddress: "2 Same Road",
        sourcePin: ["52.1", "-1.2"],
        targetAddress: "2 Same Road",
      });
      expect(pii.lat).toBe("52.1");
      expect(pii.lng).toBe("-1.2");
    });

    test("an identical address keeps the other side's only pin (target kept)", async () => {
      const pii = await mergePins({
        keep: "target",
        sourceAddress: "3 Same Road",
        sourcePin: ["52.1", "-1.2"],
        targetAddress: "3 Same Road",
      });
      expect(pii.lat).toBe("52.1");
      expect(pii.lng).toBe("-1.2");
    });

    test("keeping the target address keeps no pin when addresses differ", async () => {
      const pii = await mergePins({
        keep: "target",
        sourceAddress: "1 Source Road",
        sourcePin: ["52.1", "-1.2"],
        targetAddress: "9 Target Road",
      });
      expect(pii.lat).toBe("");
      expect(pii.lng).toBe("");
    });

    test("an identical address keeps the target's pin when the source is kept", async () => {
      const pii = await mergePins({
        keep: "source",
        sourceAddress: "4 Same Road",
        targetAddress: "4 Same Road",
        targetPin: ["53.5", "0.1"],
      });
      expect(pii.lat).toBe("53.5");
      expect(pii.lng).toBe("0.1");
    });

    test("a half-set pin is not treated as pinned", async () => {
      const pii = await mergePins({
        keep: "source",
        sourceAddress: "5 Same Road",
        sourcePin: ["52.1", ""],
        targetAddress: "5 Same Road",
      });
      expect(pii.lat).toBe("");
      expect(pii.lng).toBe("");
    });

    test("an unchanged contact keeps its record untouched during the merge", async () => {
      const { sourceToken, target } = await mergePair({
        source: { email: "jane@example.com" },
      });
      const hash = await contactHash("email", "jane@example.com");
      expect(await contactRows(hash)).toBe(1);
      const blob = async (): Promise<string | null> =>
        (
          await queryOne<{ b: string | null }>(
            "SELECT attendee_tokens_blob AS b FROM contact_preferences WHERE contact_hash = ?",
            [hash],
          )
        )?.b ?? null;
      const before = await blob();

      const { response } = await submitMerge(target.id, sourceToken);
      expectFlash(response, expect.stringContaining("Merged"), true);

      expect(await blob()).toBe(before);
    });

    test("a forgotten contact is not recreated by an unchanged merge", async () => {
      const { sourceToken, target } = await mergePair({
        source: { email: "jane@example.com" },
      });
      const hash = await contactHash("email", "jane@example.com");
      expect(await forgetContact(hash)).toBe(1);

      const { response } = await submitMerge(target.id, sourceToken);
      expectFlash(response, expect.stringContaining("Merged"), true);

      expect(await contactRows(hash)).toBe(0);
    });
  },
);
