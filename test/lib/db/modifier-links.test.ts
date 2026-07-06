import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getModifierAnswerIds,
  getModifierGroupIds,
  getModifierListingIds,
  getModifierListingIdsByModifierId,
  modifierIdsByAnswerId,
  setModifierAnswers,
  setModifierGroups,
  setModifierListings,
} from "#shared/db/modifiers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { addAnswer, createQuestion } from "../questions/helpers.ts";

describeWithEnv("db modifier links", { db: true }, () => {
  describe("setModifierListings / getModifierListingIds", () => {
    test("returns [] when the modifier has no listing links", async () => {
      expect(await getModifierListingIds(42)).toEqual([]);
    });

    test("persists the listing links, ascending", async () => {
      await setModifierListings(1, [3, 1, 2]);
      expect(await getModifierListingIds(1)).toEqual([1, 2, 3]);
    });

    test("dedupes repeated listing ids", async () => {
      await setModifierListings(1, [5, 5, 7]);
      expect(await getModifierListingIds(1)).toEqual([5, 7]);
    });

    test("replaces the previous set", async () => {
      await setModifierListings(1, [1, 2, 3]);
      await setModifierListings(1, [9]);
      expect(await getModifierListingIds(1)).toEqual([9]);
    });

    test("an empty set clears all listing links", async () => {
      await setModifierListings(1, [1, 2]);
      await setModifierListings(1, []);
      expect(await getModifierListingIds(1)).toEqual([]);
    });

    test("links are scoped per modifier", async () => {
      await setModifierListings(1, [1, 2]);
      await setModifierListings(2, [2, 3]);
      expect(await getModifierListingIds(1)).toEqual([1, 2]);
      expect(await getModifierListingIds(2)).toEqual([2, 3]);
    });
  });

  describe("getModifierListingIdsByModifierId (batched scope lookup)", () => {
    test("buckets listing links by modifier id, seeding [] for unlinked ids", async () => {
      await setModifierListings(1, [4, 6]);
      expect(await getModifierListingIdsByModifierId([1, 2])).toEqual(
        new Map([
          [1, [4, 6]],
          [2, []],
        ]),
      );
    });

    test("a single-id lookup returns that modifier's links", async () => {
      // One id is not the empty case: the query must still run for it.
      await setModifierListings(3, [5]);
      expect(await getModifierListingIdsByModifierId([3])).toEqual(
        new Map([[3, [5]]]),
      );
    });

    test("no ids short-circuits to an empty map", async () => {
      expect(await getModifierListingIdsByModifierId([])).toEqual(new Map());
    });
  });

  describe("setModifierGroups / getModifierGroupIds", () => {
    test("persists the group links, ascending and deduped", async () => {
      await setModifierGroups(1, [4, 2, 4]);
      expect(await getModifierGroupIds(1)).toEqual([2, 4]);
    });

    test("replaces the previous set, and an empty set clears it", async () => {
      await setModifierGroups(1, [1, 2]);
      await setModifierGroups(1, [8]);
      expect(await getModifierGroupIds(1)).toEqual([8]);
      await setModifierGroups(1, []);
      expect(await getModifierGroupIds(1)).toEqual([]);
    });
  });

  describe("setModifierAnswers / getModifierAnswerIds", () => {
    /** A question with three answer options, returning their ids ascending
     * (answers autoincrement, so insertion order is id order). */
    const threeAnswers = async (): Promise<number[]> => {
      const question = await createQuestion("Pick a tier");
      const answers = [];
      for (const [sortOrder, text] of ["A", "B", "C"].entries()) {
        answers.push(await addAnswer(question.id, sortOrder, text));
      }
      return answers.map((answer) => answer.id);
    };

    test("returns [] when no answers point at the modifier", async () => {
      await threeAnswers();
      expect(await getModifierAnswerIds(1)).toEqual([]);
    });

    test("points the given answers at the modifier", async () => {
      const [a, b, c] = await threeAnswers();
      await setModifierAnswers(1, [a!, c!]);
      expect(await getModifierAnswerIds(1)).toEqual([a, c]);
      // The unselected answer is untouched.
      expect(await getModifierAnswerIds(2)).not.toContain(b);
    });

    test("clears answers previously pointing at the modifier", async () => {
      const [a, b] = await threeAnswers();
      await setModifierAnswers(1, [a!]);
      await setModifierAnswers(1, [b!]);
      expect(await getModifierAnswerIds(1)).toEqual([b]);
    });

    test("an empty selection clears every answer link", async () => {
      const [a, b] = await threeAnswers();
      await setModifierAnswers(1, [a!, b!]);
      await setModifierAnswers(1, []);
      expect(await getModifierAnswerIds(1)).toEqual([]);
    });

    test("does not steal answers pointing at another modifier", async () => {
      const [a, b] = await threeAnswers();
      await setModifierAnswers(1, [a!]);
      await setModifierAnswers(2, [b!]);
      expect(await getModifierAnswerIds(1)).toEqual([a]);
      expect(await getModifierAnswerIds(2)).toEqual([b]);
    });

    test("modifierIdsByAnswerId maps linked answers only, omitting unlinked ones", async () => {
      // The reverse lookup resolve uses: each selected answer id → the single
      // modifier it activates. An answer with no modifier link must be absent,
      // never present with a null modifier.
      const [a, b] = await threeAnswers();
      await setModifierAnswers(7, [a!]);
      expect(await modifierIdsByAnswerId([a!, b!])).toEqual(
        new Map([[a!, [7]]]),
      );
    });
  });
});
