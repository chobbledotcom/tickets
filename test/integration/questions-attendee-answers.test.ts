import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#shared/db/client.ts";
import { pruneUnusedStrings } from "#shared/db/prune.ts";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
  getListingChoiceAnswerMap,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { nowIso } from "#shared/now.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withPoisonedTransactionWrite } from "#test-utils/db-poison.ts";
import { expectRejects } from "#test-utils/servicing.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
  saveTextAnswers,
} from "#test/shared/db/questions/helpers.ts";

/** The choice answer ids one attendee has saved (undefined when none). Shared by
 *  the replace and rollback tests so the read+assert pair stays one line each. */
const choiceAnswersFor = async (att: {
  id: number;
}): Promise<number[] | undefined> => {
  const batch = await getAttendeeAnswersBatch([att.id], { texts: false });
  return batch.get(att.id);
};

/** "Colour?" question with Red/Blue options plus one attendee who has saved Red
 *  — the shared setup behind the replace and rollback tests below. */
const seedColourAttendeeWithRed = async (): Promise<{
  a1: { id: number };
  a2: { id: number };
  att: { id: number };
}> => {
  const q = await createQuestion("Colour?");
  const a1 = await addAnswer(q.id, 0, "Red");
  const a2 = await addAnswer(q.id, 1, "Blue");
  const listing = await createTestListing();
  const att = await createAttendee(listing.id);
  await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));
  return { a1, a2, att };
};

describeWithEnv("custom questions", { db: true }, () => {
  describe("createAttendee helper", () => {
    test("throws when the listing has no capacity", async () => {
      const listing = await createTestListing({ maxAttendees: 0 });
      await expect(createAttendee(listing.id)).rejects.toThrow(
        "Failed to create attendee",
      );
    });
  });

  describe("attendee answers", () => {
    /** A free-text question plus a fresh attendee to answer it — shared setup
     *  for the text-answer save/dedup tests below. */
    const seedFreeTextQuestion = async (text = "Accessibility needs?") => {
      const q = await createQuestion(text, { displayType: "free_text" });
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);
      return { attendee, q };
    };

    test("saves and retrieves attendee answers", async () => {
      const q = await createQuestion("Size?");
      const a1 = await addAnswer(q.id, 0, "Small");
      await addAnswer(q.id, 1, "Large");

      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);

      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const batch = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      expect(batch.get(attendee.id)).toEqual([a1.id]);
    });

    test("batch retrieval for multiple attendees", async () => {
      const q = await createQuestion("Size?");
      const a1 = await addAnswer(q.id, 0, "Small");
      const a2 = await addAnswer(q.id, 1, "Large");

      const listing = await createTestListing();
      const att1 = await createAttendee(listing.id, "Alice");
      const att2 = await createAttendee(listing.id, "Bob");

      await saveAttendeeAnswers(new Map([[att1.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[att2.id, [a2.id]]]));

      const batch = await getAttendeeAnswersBatch([att1.id, att2.id], {
        texts: false,
      });
      expect(batch.get(att1.id)).toEqual([a1.id]);
      expect(batch.get(att2.id)).toEqual([a2.id]);
    });

    test("empty batch for no attendees", async () => {
      const batch = await getAttendeeAnswersBatch([], { texts: false });
      expect(batch.size).toBe(0);
    });

    test("getListingChoiceAnswerMap scopes answers to one listing's attendees", async () => {
      const q = await createQuestion("Size?");
      const a1 = await addAnswer(q.id, 0, "Small");
      const listing = await createTestListing();
      const other = await createTestListing();
      const mine = await createAttendee(listing.id, "Mine");
      const theirs = await createAttendee(other.id, "Theirs");
      await saveAttendeeAnswers(new Map([[mine.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[theirs.id, [a1.id]]]));

      const map = await getListingChoiceAnswerMap(listing.id);
      expect([...map.keys()]).toEqual([mine.id]);
      expect(map.get(mine.id)).toEqual([a1.id]);
    });

    test("getListingChoiceAnswerMap is empty for a listing with no answers", async () => {
      const listing = await createTestListing();
      await createAttendee(listing.id);
      const map = await getListingChoiceAnswerMap(listing.id);
      expect(map.size).toBe(0);
    });

    test("saveAttendeeAnswers does nothing for an empty map", async () => {
      await saveAttendeeAnswers(new Map());
      // No error thrown, no batch executed
    });

    test("saveAttendeeAnswers skips inserts for an answerless attendee", async () => {
      await saveAttendeeAnswers(new Map([[1, []]]));
      // No error thrown, no rows inserted (delete-only path)
    });

    test("saveAttendeeAnswers skips answer ids whose answer was deleted", async () => {
      // An answer (and its question) can be removed between checkout and
      // finalize. A dangling answer id is dropped rather than throwing, so an
      // already-captured payment's finalize still completes instead of failing
      // repeatedly.
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[att.id, [999_999]]]));
      const after = await getAttendeeAnswersBatch([att.id], { texts: false });
      expect(after.get(att.id)).toBeUndefined();
    });

    test("saveAttendeeAnswers replaces existing answers atomically", async () => {
      const { a1, a2, att } = await seedColourAttendeeWithRed();
      expect(await choiceAnswersFor(att)).toEqual([a1.id]);

      await saveAttendeeAnswers(new Map([[att.id, [a2.id]]]));

      expect(await choiceAnswersFor(att)).toEqual([a2.id]);
    });

    test("saveAttendeeAnswers rolls back the DELETE when the INSERT fails", async () => {
      // Regression for the CodeRabbit gap on PR #1678: the delete and insert
      // used to be two committed batches, so an INSERT failure after the DELETE
      // committed left the attendee with no answers at all. Now the whole save
      // runs in one transaction, so a mid-save INSERT failure rolls the DELETE
      // back and the attendee's prior answers survive.
      const { a1, a2, att } = await seedColourAttendeeWithRed();
      expect(await choiceAnswersFor(att)).toEqual([a1.id]);

      await withPoisonedTransactionWrite(
        (sql) => sql.includes("INSERT INTO attendee_answers"),
        "insert boom",
      )(async () => {
        await expectRejects(
          saveAttendeeAnswers(new Map([[att.id, [a2.id]]])),
          /insert boom/,
        );
      });

      // The DELETE rolled back with the failed INSERT: a1 survives, not empty.
      expect(await choiceAnswersFor(att)).toEqual([a1.id]);
    });

    test("saveAttendeeAnswers rollback preserves a FREE-TEXT answer, not just choice ids", async () => {
      // The choice-only rollback test above can't catch free-text loss: a
      // free-text answer is interned into the strings table and referenced by
      // string_id, so a non-atomic delete-then-insert that drops the text row
      // and then fails on the re-insert loses the attendee's free-text answer
      // even though the choice path looked intact. This test seeds a free-text
      // answer, forces the INSERT to fail mid-save, and asserts the decrypted
      // text survives the rollback.
      const { attendee: att, q } = await seedFreeTextQuestion("Notes?");
      const privateKey = await getTestPrivateKey();
      await saveTextAnswers(att.id, [{ questionId: q.id, text: "Keep me" }]);
      expect((await getAttendeeTextAnswers(att.id, privateKey)).get(q.id)).toBe(
        "Keep me",
      );

      await withPoisonedTransactionWrite(
        (sql) => sql.includes("INSERT INTO attendee_answers"),
        "insert boom",
      )(async () => {
        await expectRejects(
          saveTextAnswers(att.id, [
            { questionId: q.id, text: "Should not land" },
          ]),
          /insert boom/,
        );
      });

      // The free-text answer survived the rolled-back save, not lost.
      expect((await getAttendeeTextAnswers(att.id, privateKey)).get(q.id)).toBe(
        "Keep me",
      );
    });

    test("saves text-only answers and decrypts them for editing", async () => {
      const { attendee, q } = await seedFreeTextQuestion();

      await saveTextAnswers(attendee.id, [
        { questionId: q.id, text: "Front row please" },
      ]);

      const textAnswers = await getAttendeeTextAnswers(
        attendee.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Front row please");

      const strings = await queryAll<{ created: string; used_count: number }>(
        "SELECT created, used_count FROM strings",
      );
      expect(strings.map((row) => row.used_count)).toEqual([1]);
      expect(Number.isNaN(Date.parse(strings[0]!.created))).toBe(false);
    });

    test("deduplicates repeated text answers by question before saving", async () => {
      const { attendee, q } = await seedFreeTextQuestion();

      await saveTextAnswers(attendee.id, [
        { questionId: q.id, text: "First answer" },
        { questionId: q.id, text: "Final answer" },
      ]);

      const textAnswers = await getAttendeeTextAnswers(
        attendee.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Final answer");

      const strings = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(strings.map((row) => row.used_count)).toEqual([1]);
    });

    test("re-saving an unchanged sole-user text answer keeps it readable", async () => {
      // Regression: strings used to be resolved before the per-attendee delete,
      // so a sole user re-saving the same text had its string dropped by the
      // delete trigger and the re-insert pointed at a now-missing row.
      const { attendee: att, q } = await seedFreeTextQuestion("Notes?");
      const keepMe = [{ questionId: q.id, text: "Keep me" }];

      await saveTextAnswers(att.id, keepMe);
      await saveTextAnswers(att.id, keepMe);

      const textAnswers = await getAttendeeTextAnswers(
        att.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Keep me");
    });

    test("deduplicates identical text answers and leaves freed rows for the pruner", async () => {
      const q = await createQuestion("Dietary needs?", {
        displayType: "free_text",
      });
      const listing = await createTestListing();
      const att1 = await createAttendee(listing.id, "Alice");
      const att2 = await createAttendee(listing.id, "Bob");
      const answerSet = {
        answerIds: [],
        textAnswers: [{ questionId: q.id, text: "Vegan" }],
      };

      await saveAttendeeAnswers(
        new Map([
          [att1.id, answerSet],
          [att2.id, answerSet],
        ]),
      );

      const afterInsert = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(afterInsert.map((row) => row.used_count)).toEqual([2]);

      await saveAttendeeAnswers(new Map([[att1.id, []]]));
      const afterOneClear = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(afterOneClear.map((row) => row.used_count)).toEqual([1]);

      // Freeing the last reference does NOT delete the row — a pending paid
      // checkout could still reference it in its signed metadata. The row
      // lingers at used_count 0 until the age-based pruner removes it.
      await saveAttendeeAnswers(new Map([[att2.id, []]]));
      const afterAllClear = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(afterAllClear.map((row) => row.used_count)).toEqual([0]);

      // Once aged past retention, the pruner deletes the unused row.
      await execute(
        "UPDATE strings SET created = '2000-01-01T00:00:00Z' WHERE used_count = 0",
      );
      await pruneUnusedStrings();
      expect(await queryAll("SELECT id FROM strings")).toEqual([]);
    });

    test("skips a text answer whose question was deleted at finalize", async () => {
      // A free-text question can be deleted between checkout and finalize; the
      // signed metadata still references it, but inserting would create an
      // orphan row whose plaintext the admin UI can never surface, so it is
      // dropped.
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveTextAnswers(att.id, [{ questionId: 999_999, text: "orphan" }]);
      const texts = await getAttendeeTextAnswers(
        att.id,
        await getTestPrivateKey(),
      );
      expect(texts.size).toBe(0);
    });

    test("refreshes created on a reused but still-unattached string", async () => {
      const ids = await getOrCreateStringIds(["reuse me"]);
      const id = ids.get("reuse me")!;
      // Backdate it as if abandoned by an earlier checkout.
      await execute("UPDATE strings SET created = ? WHERE id = ?", [
        "2000-01-01T00:00:00Z",
        id,
      ]);

      const beforeReuse = nowIso();
      const reused = await getOrCreateStringIds(["reuse me"]);
      expect(reused.get("reuse me")).toBe(id);

      const rows = await queryAll<{ created: string }>(
        "SELECT created FROM strings WHERE id = ?",
        [id],
      );
      // The refreshed timestamp must be at least the instant before the reuse,
      // not merely "after the backdated 2000 value" — this catches a mutant
      // that writes any stale-but-post-2001 time instead of the current one.
      const refreshed = Date.parse(rows[0]!.created);
      expect(refreshed).toBeGreaterThanOrEqual(Date.parse(beforeReuse));
    });

    test("saveAttendeeAnswers with empty answerIds clears answers", async () => {
      const q = await createQuestion("Colour?");
      const a1 = await addAnswer(q.id, 0, "Red");

      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));

      await saveAttendeeAnswers(new Map([[att.id, []]]));

      const after = await getAttendeeAnswersBatch([att.id], { texts: false });
      expect(after.get(att.id)).toBeUndefined();
    });
  });
});
