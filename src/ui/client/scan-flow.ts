/// <reference lib="dom" />
/** One scan's talk with the door. The camera scan, the manual check-in,
 * and the offline queue share it. It holds the post, the asks the door
 * answers, the words of each answer, and how a failure reaches the door. */

import * as v from "valibot";
import type { Wording } from "#shared/scanner-words.ts";
import { showConfirm } from "./confirm-dialog.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import {
  type AnswerOf,
  type ScanAnswer,
  ScanAnswerSchema,
} from "./scan-answer.ts";
import type { Say, StatusType } from "./scanner-messages.ts";

/** The request never reached the server: the device has no connection. */
export class NetworkError extends Error {}

/** Fetch one request. A request that never reached the server, or one the
 * page stopped, throws `NetworkError`. Any answer, a refusal included,
 * comes back. */
export const fetchOrNetworkError = async (
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new NetworkError(`The request to ${url} never reached the server`, {
      cause,
    });
  }
};

/** Post one JSON body to a door's scan route and parse its answer. */
export const postScanBody = async (
  scanPath: string,
  csrfToken: string,
  body: Record<string, unknown>,
): Promise<ScanAnswer> => {
  const res = await fetchOrNetworkError(scanPath, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  });
  return v.parse(ScanAnswerSchema, await res.json());
};

/** What the door answered so far for one scan. */
export type Given = { force?: true; id_verified?: true; quantity?: number };

/** Post one scan with every answer the door gave so far, and answer the
 * door's word for it. */
export type ScanPost = (given: Given) => Promise<ScanAnswer>;

/** How a page talks to the door: its words, and where it reports. */
export type Voice = { say: Say; wording: Wording };

/** An answer that asks the door something. */
type Ask = AnswerOf<"select_quantity" | "verify_id" | "wrong_listing">;

/** The questions one kind of scan lets the door answer. */
export type AskStatus = Ask["status"];

/** Whether the door already answered each kind of question. */
const ANSWERED: Record<AskStatus, (given: Given) => boolean> = {
  select_quantity: (given) => given.quantity !== undefined,
  verify_id: (given) => given.id_verified === true,
  wrong_listing: (given) => given.force === true,
};

/** The question an answer asks that the door can answer and has not, or
 * null. */
const pendingAskOrNull = (
  answer: ScanAnswer,
  asks: readonly AskStatus[],
  given: Given,
): Ask | null => {
  const isAsk = (scan: ScanAnswer): scan is Ask => scan.status in ANSWERED;
  return isAsk(answer) &&
    asks.includes(answer.status) &&
    !ANSWERED[answer.status](given)
    ? answer
    : null;
};

/** Ask the door one question. Answers what to re-post, or null after the
 * door declined and heard why nobody was checked in. A non-transferable
 * listing needs the door to look at the person's ID and say so. A ticket
 * that owes more than one place asks how many to admit. */
const askDoor = async (
  ask: Ask,
  { say, wording }: Voice,
): Promise<Given | null> => {
  const decline = (text: string): null => {
    say(text, ask.status === "verify_id" ? "error" : "warning");
    return null;
  };
  const skipped = wording.fill("skipped", { name: ask.name });
  if (ask.status === "wrong_listing") {
    const confirmed = await showConfirm(
      wording.fill("wrongListingConfirm", {
        listingName: ask.listingName,
        name: ask.name,
      }),
    );
    return confirmed ? { force: true } : decline(skipped);
  }
  if (ask.status === "verify_id") {
    const confirmed = await showConfirm(
      wording.fill("verifyIdConfirm", { name: ask.name }),
    );
    return confirmed
      ? { id_verified: true }
      : decline(wording.fill("idMismatch", { name: ask.name }));
  }
  const count = await showQuantitySelect(
    ask.max,
    wording.fill("selectQuantity", { name: ask.name }),
    wording.ticketCount,
  );
  return count === null ? decline(skipped) : { quantity: count };
};

/** How one scan settled: the door's final answer, or the ask the door
 * declined. */
export type Settled =
  | { answer: ScanAnswer; declined: false }
  | { answer: Ask; declined: true };

/** Settle one scan with the door. Each ask is answered once: the re-post
 * carries every earlier answer, so a verified ID still stands when the
 * door then picks a count. */
export const settleScan = async (
  post: ScanPost,
  asks: readonly AskStatus[],
  voice: Voice,
): Promise<Settled> => {
  const settleFrom = async (
    answer: ScanAnswer,
    given: Given,
  ): Promise<Settled> => {
    const ask = pendingAskOrNull(answer, asks, given);
    if (ask === null) return { answer, declined: false };
    const choice = await askDoor(ask, voice);
    if (choice === null) return { answer: ask, declined: true };
    const next = { ...given, ...choice };
    return settleFrom(await post(next), next);
  };
  return settleFrom(await post({}), {});
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
  // Only a forced rescan lands here: a ticket whose only rows are
  // "No check-in" answers wrong_listing again.
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

/** Whether an error is the browser refusing a write because the site's
 * store is full. */
export const isStoreFull = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "QuotaExceededError";

/** The word for one failure. */
const failureWord = (
  error: unknown,
): "networkError" | "offlineSaveFailed" | "pageError" | "storageBlocked" => {
  if (error instanceof NetworkError) return "networkError";
  if (isStoreFull(error)) return "offlineSaveFailed";
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "storageBlocked";
  }
  return "pageError";
};

/** Settle one live scan: the door answers every ask the scan raises, then
 * hears the final answer. A declined ask already told the door why. */
export const settleLiveScan = async (
  post: ScanPost,
  voice: Voice,
): Promise<Settled> => {
  const settled = await settleScan(
    post,
    ["select_quantity", "verify_id", "wrong_listing"],
    voice,
  );
  if (!settled.declined) sayAnswer(settled.answer, voice.wording, voice.say);
  return settled;
};
