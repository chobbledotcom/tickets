/** The email answer lines: choices load from the database, free-text answers
 * arrive from the sender that holds them, and each entry sees only the
 * questions its own listing asks. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { questionListings } from "#db/questions/queries.ts";
import { records } from "#db/record-table.ts";
import {
  eachAnswerOnce,
  entryAnswerLines,
  entryKey,
  type FreeTextAnswers,
  heldFreeTexts,
  loadOrderAnswerLines,
  orderAnswerLines,
  type QuestionContext,
  withoutMemberNames,
} from "#shared/email/answers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { testAnswer } from "#test-utils/factories-questions.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

interface SeededQuestion {
  answerId: number;
  questionId: number;
}

/** One choice question with an extra chosen option, assigned to listings. */
const seedChoiceQuestion = async (
  assignedTo: number[],
  text = "Any allergies?",
): Promise<SeededQuestion> => {
  const question = await records.questions.insert({
    displayType: "radio",
    text,
  });
  const chosen = await records.answers.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Shellfish",
  });
  await questionListings.setIds(question.id, assignedTo);
  return { answerId: chosen.id, questionId: question.id };
};

type FreeTexts = ReadonlyMap<string, string>;

describeWithEnv("order answer lines", { db: true }, () => {
  const bookedBuyer = async (listingName: string) => {
    const listing = await createTestListing({ name: listingName });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Booked",
      "buyer@example.com",
    );
    return { attendee, listing };
  };

  /** A buyer who booked a listing and answered a choice question on it. */
  const buyerWithChosenAnswer = async (listingName: string) => {
    const { attendee, listing } = await bookedBuyer(listingName);
    const { answerId } = await seedChoiceQuestion([listing.id]);
    await saveAttendeeAnswers(new Map([[attendee.id, [answerId]]]));
    return { attendee, listing };
  };

  /** The answer lines on each of the attendee's entries, in listing order. */
  const shownLines = async (
    attendeeId: number,
    listings: readonly { id: number; name: string }[],
    freeTexts?: FreeTexts,
    packageGroupId = 0,
  ) => {
    const entries = listings.map(({ id, name }) =>
      makeEntry(
        { id, name },
        { id: attendeeId, package_group_id: packageGroupId },
      ),
    );
    const lines = await loadOrderAnswerLines(entries, freeTexts);
    return entries.map((entry) => lines.get(entryKey(entry)));
  };

  test("shows the chosen answer of a question the listing asks", async () => {
    const { attendee, listing } = await buyerWithChosenAnswer("Fete");

    expect(await shownLines(attendee.id, [listing])).toEqual([
      [{ question: "Any allergies?", text: "Shellfish" }],
    ]);
  });

  test("keeps a question off a listing it was not assigned to", async () => {
    const { attendee, listing: asking } = await bookedBuyer("Asking");
    const other = await createTestListing({ name: "Other" });
    const { answerId } = await seedChoiceQuestion([asking.id]);
    await saveAttendeeAnswers(new Map([[attendee.id, [answerId]]]));

    expect(await shownLines(attendee.id, [other])).toEqual([[]]);
  });

  test("skips a question the attendee left unanswered", async () => {
    const { attendee, listing } = await bookedBuyer("Fete");
    await seedChoiceQuestion([listing.id]);

    expect(await shownLines(attendee.id, [listing])).toEqual([[]]);
  });

  test("places each entry's answers under its own listing", async () => {
    const { attendee, listing: first } = await bookedBuyer("One");
    const second = await createTestListing({ name: "Two" });
    const onFirst = await seedChoiceQuestion([first.id], "Diet?");
    await seedChoiceQuestion([second.id], "Shirt size?");
    await saveAttendeeAnswers(new Map([[attendee.id, [onFirst.answerId]]]));

    expect(await shownLines(attendee.id, [first, second])).toEqual([
      [{ question: "Diet?", text: "Shellfish" }],
      [],
    ]);
  });

  test("names a ticket answer in a package by its package", async () => {
    const { attendee, listing } = await bookedBuyer("Hall");
    const pack = await createTestGroup({ isPackage: true, name: "Party Pack" });
    const { question } = await seedListingLevelQuestion(
      [listing.id],
      "Pupil name",
      "quantity",
    );
    const field = `question${question.id}_line${listing.id}_0_${pack.id}_ticket0`;

    const [lines] = await shownLines(
      attendee.id,
      [listing],
      new Map([[field, "Ava"]]),
      pack.id,
    );

    expect(lines).toEqual([
      {
        concealedQuestion: "Pupil name (Party Pack, ticket 1)",
        question: "Pupil name (Hall in Party Pack, ticket 1)",
        text: "Ava",
      },
    ]);
  });

  test("names the package of a row that rests under a parent", async () => {
    const { attendee, listing } = await bookedBuyer("Hall");
    const pack = await createTestGroup({ isPackage: true, name: "Party Pack" });
    const { question } = await seedListingLevelQuestion(
      [listing.id],
      "Pupil name",
      "quantity",
    );
    const field = `question${question.id}_line${listing.id}_900_0_ticket0`;

    const [lines] = await shownLines(
      attendee.id,
      [listing],
      new Map([[field, "Ava"]]),
      pack.id,
    );

    expect(lines?.map(({ concealedQuestion }) => concealedQuestion)).toEqual([
      "Pupil name (Party Pack, ticket 1)",
    ]);
  });

  /** A line whose parent listing or package was deleted: the field of its
   * answer, and the words the email shows for the line. */
  const MISSING_NAMES: [string, (id: number) => string, string, number][] = [
    [
      "a deleted parent listing",
      (id) => `_line${id}_900_0_ticket0`,
      "Hall with #900",
      0,
    ],
    [
      "a deleted package",
      (id) => `_line${id}_0_901_ticket0`,
      "Hall in #901",
      901,
    ],
  ];

  for (const [name, fieldEnd, words, packageId] of MISSING_NAMES) {
    test(`names a line by its number when it rests under ${name}`, async () => {
      const { attendee, listing } = await bookedBuyer("Hall");
      const { question } = await seedListingLevelQuestion(
        [listing.id],
        "Pupil name",
        "quantity",
      );
      const field = `question${question.id}${fieldEnd(listing.id)}`;

      const [lines] = await shownLines(
        attendee.id,
        [listing],
        new Map([[field, "Ava"]]),
        packageId,
      );

      expect(lines?.map(({ question }) => question)).toEqual([
        `Pupil name (${words}, ticket 1)`,
      ]);
    });
  }

  /** Orders that spend two reads: how many entries the order has, and the
   * free texts it holds. A free text that rests in no package reads no
   * package names. */
  const TWO_READS: [string, number, (listingId: number) => FreeTexts][] = [
    ["however many entries the order has", 2, () => new Map()],
    [
      "with free texts that rest in no package",
      1,
      (listingId) =>
        new Map([
          ["12", "Coming by bus"],
          [`question13_line${listingId}_0_0_ticket0`, "Ava"],
        ]),
    ],
  ];

  for (const [name, entryCount, freeTexts] of TWO_READS) {
    test(`spends fixed database reads ${name}`, async () => {
      const { attendee, listing } = await buyerWithChosenAnswer("Fete");
      const entry = makeEntry({ id: listing.id }, { id: attendee.id });

      const calls = await countDatabaseCalls(2, () =>
        loadOrderAnswerLines(
          Array.from({ length: entryCount }, () => entry),
          freeTexts(listing.id),
        ),
      );

      expect(calls).toBe(2);
    });
  }
});

describe("order answer lines from staged question data", () => {
  const question = (
    id: number,
    text: string,
    answers: { id: number; text: string }[],
    opts: {
      answerLevel?: QuestionWithAnswers["answerLevel"];
      assignAll?: boolean;
      displayType?: "radio" | "free_text";
    } = {},
  ) => ({
    answerLevel: opts.answerLevel ?? "booking",
    answers: answers.map((a) =>
      testAnswer({ id: a.id, questionId: id, text: a.text }),
    ),
    assignAll: opts.assignAll ?? false,
    displayType: opts.displayType ?? "radio",
    id,
    text,
  });

  const chosen = new Map([[7, [31, 32]]]);
  const ctx = (
    questions: QuestionWithAnswers[],
    freeTexts: FreeTextAnswers = new Map(),
  ): QuestionContext => ({
    chosenByAttendee: chosen,
    freeTexts,
    names: {
      listings: new Map([
        [101, "Disco A"],
        [102, "Disco B"],
      ]),
      packages: new Map(),
    },
    questionListingMap: new Map([
      [11, [101]],
      [12, [101]],
      [13, [101, 102]],
    ]),
    questions,
  });

  const pupilName = question(13, "Pupil name", [], {
    answerLevel: "quantity",
    displayType: "free_text",
  });

  test("merges free-text answers with choice answers in question order", () => {
    const entry = makeEntry({ id: 101 }, { id: 7 });
    const lines = orderAnswerLines(
      [entry],
      ctx(
        [
          question(11, "Any allergies?", [{ id: 31, text: "Peanuts" }]),
          question(12, "Anything else?", [], { displayType: "free_text" }),
        ],
        new Map([["12", "Coming by bus"]]),
      ),
    );

    expect(lines.get(entryKey(entry))).toEqual([
      { question: "Any allergies?", text: "Peanuts" },
      { question: "Anything else?", text: "Coming by bus" },
    ]);
  });

  test("asks an assign-all question on every listing", () => {
    const entry = makeEntry({ id: 999 }, { id: 7 });
    const lines = orderAnswerLines(
      [entry],
      ctx([
        question(11, "Club member?", [{ id: 31, text: "Yes" }], {
          assignAll: true,
        }),
      ]),
    );

    expect(lines.get(entryKey(entry))).toEqual([
      { question: "Club member?", text: "Yes" },
    ]);
  });

  test("shows each line answer under its listing's entry, named by its line and ticket", () => {
    const discoA = makeEntry({ id: 101 }, { id: 7 });
    const discoB = makeEntry({ id: 102 }, { id: 7 });
    const lines = orderAnswerLines(
      [discoA, discoB],
      ctx(
        [pupilName],
        new Map([
          ["question13_line101_0_0_ticket0", "Sam"],
          ["question13_line101_0_0_ticket1", "Sam"],
          ["question13_line102_0_0_ticket0", "Ben"],
        ]),
      ),
    );

    expect([lines.get(entryKey(discoA)), lines.get(entryKey(discoB))]).toEqual([
      [
        { question: "Pupil name (Disco A, ticket 1)", text: "Sam" },
        { question: "Pupil name (Disco A, ticket 2)", text: "Sam" },
      ],
      [{ question: "Pupil name (Disco B, ticket 1)", text: "Ben" }],
    ]);
    expect(eachAnswerOnce(lines.get(entryKey(discoA)) ?? [])).toHaveLength(2);
  });

  test("omits a free-text question when no text was held for it", () => {
    const entry = makeEntry({ id: 101 }, { id: 7 });
    const lines = orderAnswerLines(
      [entry],
      ctx([question(12, "Anything else?", [], { displayType: "free_text" })]),
    );

    expect(lines.get(entryKey(entry))).toEqual([]);
  });

  const LINE_SLOT = { listingId: 101, packageGroupId: 0, parentListingId: 0 };
  const held = (startAt: string | null, text: string, unit = 0) =>
    ({ ...LINE_SLOT, questionId: 13, startAt, text, unit }) as const;
  const pupilLines = (
    entries: ReturnType<typeof makeEntry>[],
    freeTexts: FreeTextAnswers,
    packages = new Map<number, string>(),
  ) => {
    const lines = orderAnswerLines(entries, {
      ...ctx([pupilName], freeTexts),
      names: { listings: new Map([[101, "Disco A"]]), packages },
    });
    return entries.map((entry) => lines.get(entryKey(entry)));
  };

  test("keeps a package row's answers apart from a plain row of the same listing", () => {
    const [plain, packaged] = pupilLines(
      [
        makeEntry({ id: 101 }, { id: 7, package_group_id: 0 }),
        makeEntry({ id: 101 }, { id: 7, package_group_id: 5 }),
      ],
      new Map([
        ["question13_line101_0_0_ticket0", "Sam"],
        ["question13_line101_0_5_ticket0", "Ben"],
      ]),
      new Map([[5, "Party Pack"]]),
    );

    expect(plain).toEqual([
      { question: "Pupil name (Disco A, ticket 1)", text: "Sam" },
    ]);
    expect(packaged).toEqual([
      {
        concealedQuestion: "Pupil name (Party Pack, ticket 1)",
        question: "Pupil name (Disco A in Party Pack, ticket 1)",
        text: "Ben",
      },
    ]);
    expect(packaged?.map(withoutMemberNames)).toEqual([
      { question: "Pupil name (Party Pack, ticket 1)", text: "Ben" },
    ]);
  });

  test("keeps the answers of one slot on two dates apart", () => {
    const texts = heldFreeTexts(
      [],
      [
        held("2026-09-07T10:00:00.000Z", "Sam"),
        held("2026-09-08T10:00:00.000Z", "Ben"),
      ],
    );

    const answered = pupilLines(
      [
        makeEntry({ id: 101 }, { date: "2026-09-07", id: 7 }),
        makeEntry({ id: 101 }, { date: "2026-09-08", id: 7 }),
      ],
      texts,
    ).map((lines) => lines?.map(({ text }) => text));

    expect(answered).toEqual([["Sam"], ["Ben"]]);
  });

  test("gives the answer of a row with no date to the entry with no date", () => {
    const answered = pupilLines(
      [
        makeEntry({ id: 101 }, { date: "2026-09-07", id: 7 }),
        makeEntry({ id: 101 }, { date: null, id: 7 }),
      ],
      heldFreeTexts([], [held(null, "Sam")]),
    ).map((lines) => lines?.map(({ text }) => text));

    expect(answered).toEqual([[], ["Sam"]]);
  });
});

describe("entryAnswerLines", () => {
  const entry = makeEntry({ id: 3 }, { id: 9 });
  const line = { question: "Diet?", text: "Vegan" };

  test("reads one entry's lines", () => {
    expect(
      entryAnswerLines(new Map([[entryKey(entry), [line]]]))(entry),
    ).toEqual([line]);
  });

  test("throws for a booking row the loader never filled", () => {
    expect(() => entryAnswerLines(new Map())(entry)).toThrow(
      `Missing map key ${entryKey(entry)}`,
    );
  });
});

describe("eachAnswerOnce", () => {
  test("keeps the first of two equal lines and every different one", () => {
    const vegan = { question: "Diet?", text: "Vegan" };
    expect(
      eachAnswerOnce([
        vegan,
        { question: "Diet?", text: "None" },
        { ...vegan },
        { question: "Diet? Vegan", text: "" },
      ]),
    ).toEqual([
      vegan,
      { question: "Diet?", text: "None" },
      { question: "Diet? Vegan", text: "" },
    ]);
  });
});
