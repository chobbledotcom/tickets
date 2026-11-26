import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { wordingOf } from "#shared/scanner-words.ts";
import type { ScanAnswer } from "#src/ui/client/scan-answer.ts";
import {
  CAMERA_ASKS,
  type Dialogs,
  type Given,
  PICK_ASKS,
  settleScan,
} from "#src/ui/client/scan-asks.ts";
import { PAGE_WORDS } from "#test/ui/client/scanner/words.ts";

const WRONG_LISTING: ScanAnswer = {
  listingName: "Tour",
  name: "Ada",
  status: "wrong_listing",
};

const CHECKED_IN: ScanAnswer = {
  listingName: "Ceilidh",
  name: "Ada",
  quantity: 2,
  remaining: 0,
  status: "checked_in",
  total: 2,
};

/** Settle one scan whose door answers `answers` in turn, with the door's
 * confirm answering `confirmed` and its count pick answering `picked`.
 * Answers what the scan sent, what the dialogs were asked, what the door
 * heard, and how the scan settled. */
const settleWith = async (
  asks: Parameters<typeof settleScan>[1],
  answers: ScanAnswer[],
  confirmed: boolean,
  picked: number | null = null,
) => {
  const sent: Given[] = [];
  const asked: string[] = [];
  const said: [string, string][] = [];
  const dialogs: Dialogs = {
    confirm: (text) => {
      asked.push(text);
      return Promise.resolve(confirmed);
    },
    quantity: (max, text) => {
      asked.push(`${text} (up to ${max})`);
      return Promise.resolve(picked);
    },
  };
  const settled = await settleScan(
    (given) => {
      sent.push(given);
      return Promise.resolve(answers[sent.length - 1]!);
    },
    asks,
    {
      dialogs,
      say: (text, type) => said.push([text, type]),
      wording: wordingOf(PAGE_WORDS),
    },
  );
  return { asked, said, sent, settled };
};

const WIDEN_WORDS =
  'Ada is registered for "Tour", not this listing. Check in anyway?';
const ID_CHECK: ScanAnswer = { name: "Ada", status: "verify_id" };
const COUNT_ASK: ScanAnswer = {
  max: 3,
  name: "Ada",
  status: "select_quantity",
};

/** One scan's case: the asks its route allows, the door's answers in turn,
 * the dialogs' replies, and what the scan must ask, send, settle and say. */
type AskCase = {
  name: string;
  asks: Parameters<typeof settleScan>[1];
  answers: ScanAnswer[];
  confirmed: boolean;
  picked?: number | null;
  asked: string[];
  sent: Given[];
  settled: Awaited<ReturnType<typeof settleScan>>;
  said: [string, string][];
};

/* jscpd:ignore-start -- static data, not code */
const ASK_CASES: AskCase[] = [
  {
    answers: [WRONG_LISTING, CHECKED_IN],
    asked: [WIDEN_WORDS],
    asks: CAMERA_ASKS,
    confirmed: true,
    name: "widens a camera scan to the other listing once the door says yes",
    said: [],
    sent: [{}, { force: true }],
    settled: { answer: CHECKED_IN, declined: false },
  },
  {
    answers: [WRONG_LISTING],
    asked: [WIDEN_WORDS],
    asks: CAMERA_ASKS,
    confirmed: false,
    name: "skips the person when the door will not widen the door",
    said: [["Skipped Ada", "warning"]],
    sent: [{}],
    settled: { answer: WRONG_LISTING, declined: true },
  },
  {
    answers: [WRONG_LISTING],
    asked: [],
    asks: PICK_ASKS,
    confirmed: true,
    name: "never asks a pick to widen the door",
    said: [],
    sent: [{}],
    settled: { answer: WRONG_LISTING, declined: false },
  },
  {
    answers: [ID_CHECK, CHECKED_IN],
    asked: ['Does their ID match "Ada"?'],
    asks: PICK_ASKS,
    confirmed: true,
    name: "re-posts with the ID check once the door says the ID matches",
    said: [],
    sent: [{}, { id_verified: true }],
    settled: { answer: CHECKED_IN, declined: false },
  },
  {
    answers: [ID_CHECK],
    asked: ['Does their ID match "Ada"?'],
    asks: PICK_ASKS,
    confirmed: false,
    name: "checks nobody in when the door says the ID does not match",
    said: [["ID does not match Ada", "error"]],
    sent: [{}],
    settled: { answer: ID_CHECK, declined: true },
  },
  {
    answers: [COUNT_ASK, CHECKED_IN],
    asked: ["How many tickets for Ada? (up to 3)"],
    asks: PICK_ASKS,
    confirmed: true,
    name: "re-posts with the count the door picks",
    picked: 2,
    said: [],
    sent: [{}, { quantity: 2 }],
    settled: { answer: CHECKED_IN, declined: false },
  },
  {
    answers: [COUNT_ASK],
    asked: ["How many tickets for Ada? (up to 3)"],
    asks: PICK_ASKS,
    confirmed: true,
    name: "skips the person when the door cancels the count",
    picked: null,
    said: [["Skipped Ada", "warning"]],
    sent: [{}],
    settled: { answer: COUNT_ASK, declined: true },
  },
];
/* jscpd:ignore-end */

describe("the asks one scan raises", () => {
  for (const askCase of ASK_CASES) {
    test(askCase.name, async () => {
      const { asked, said, sent, settled } = await settleWith(
        askCase.asks,
        askCase.answers,
        askCase.confirmed,
        askCase.picked,
      );

      expect({ asked, said, sent, settled }).toEqual({
        asked: askCase.asked,
        said: askCase.said,
        sent: askCase.sent,
        settled: askCase.settled,
      });
    });
  }
});
