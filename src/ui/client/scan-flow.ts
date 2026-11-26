/// <reference lib="dom" />
/** One scan's talk with the door. The camera scan, the manual check-in,
 * and the offline queue share it. It holds the post, the page's dialogs,
 * the words of each answer, and how a failure reaches the door. The asks
 * themselves live in the pure `scan-asks.ts`. */

import * as v from "valibot";
import type { Wording } from "#shared/scanner-words.ts";
import { showConfirm } from "./confirm-dialog.ts";
import { NetworkError, postJson } from "./dom.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import {
  type AnswerOf,
  type ScanAnswer,
  ScanAnswerSchema,
} from "./scan-answer.ts";
import {
  type AskStatus,
  type Dialogs,
  type ScanPost,
  type Settled,
  settleScan,
  type Voice,
} from "./scan-asks.ts";
import type { Say, StatusType } from "./scanner-messages.ts";
import { isStoreBlocked, isStoreFull } from "./scanner-storage.ts";

/** Post one JSON body to a door's scan route and parse its answer. */
export const postScanBody = async (
  scanPath: string,
  csrfToken: string,
  body: Record<string, unknown>,
): Promise<ScanAnswer> =>
  v.parse(ScanAnswerSchema, await postJson(scanPath, csrfToken, body));

/** The page's own dialogs: the overlay asks a scan raises. */
export const browserDialogs: Dialogs = {
  confirm: showConfirm,
  quantity: showQuantitySelect,
};

/** The words of an answer that counts places: who, where, and how many. */
const countedWords = (
  name: "alreadyCheckedIn" | "checkedIn",
  answer: AnswerOf<"already_checked_in" | "checked_in">,
  wording: Wording,
): string =>
  wording.fill(name, {
    listingName: answer.listingName,
    name: answer.name,
    tickets: wording.ticketCount(answer.quantity),
  });

/** An answer that shows one fixed error word. */
const errorWord =
  (name: "error" | "noDoor" | "notFound") =>
  (_answer: unknown, wording: Wording): [string, StatusType] => [
    wording.word(name),
    "error",
  ];

/** The words and the kind of one final answer. An ask that comes back
 * after the door answered it is an answer the page cannot settle. */
const ANSWER_WORDS: {
  [Status in ScanAnswer["status"]]: (
    answer: AnswerOf<Status>,
    wording: Wording,
  ) => [string, StatusType];
} = {
  already_checked_in: (answer, wording) => [
    countedWords("alreadyCheckedIn", answer, wording),
    "warning",
  ],
  checked_in: (answer, wording) => [
    answer.total > answer.quantity
      ? wording.fill("checkedInPartial", {
          listingName: answer.listingName,
          name: answer.name,
          tickets: answer.quantity,
          total: answer.total,
        })
      : countedWords("checkedIn", answer, wording),
    "success",
  ],
  not_found: errorWord("notFound"),
  other: (answer, wording) => [answer.error ?? wording.word("error"), "error"],
  refunded: (answer, wording) => [
    wording.fill("refunded", { name: answer.name }),
    "error",
  ],
  select_quantity: errorWord("error"),
  verify_id: errorWord("error"),
  // A forced rescan lands here when a ticket's only rows are "No check-in".
  // A stray wrong-listing answer to a scan that cannot widen lands here too.
  wrong_listing: errorWord("noDoor"),
};

/** Show the door what one final answer means. */
export const sayAnswer = (
  answer: ScanAnswer,
  wording: Wording,
  say: Say,
): void => {
  const words = ANSWER_WORDS[answer.status] as (
    answer: ScanAnswer,
    wording: Wording,
  ) => [string, StatusType];
  say(...words(answer, wording));
};

/** Show the door why something failed. A request that never reached the
 * server, a full store, and a store the browser blocks each have their own
 * words. Anything else is a fault this page cannot name, so the door is told
 * to reload. */
export const failLoudly =
  (wording: Wording, say: Say) =>
  (error: unknown): void => {
    say(wording.word(failureWord(error)), "error");
  };

/** The word for one failure. */
const failureWord = (
  error: unknown,
): "networkError" | "offlineSaveFailed" | "pageError" | "storageBlocked" => {
  if (error instanceof NetworkError) return "networkError";
  if (isStoreFull(error)) return "offlineSaveFailed";
  if (isStoreBlocked(error)) return "storageBlocked";
  return "pageError";
};

/** Settle one live scan: the door answers every ask in `asks` the scan
 * raises, then hears the final answer. A declined ask already told the
 * door why. */
export const settleLiveScan = async (
  post: ScanPost,
  asks: readonly AskStatus[],
  voice: Voice,
): Promise<Settled> => {
  const settled = await settleScan(post, asks, {
    ...voice,
    dialogs: browserDialogs,
  });
  if (!settled.declined) sayAnswer(settled.answer, voice.wording, voice.say);
  return settled;
};
