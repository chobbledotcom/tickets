// effects: pure
/** The questions one scan asks the door, and the loop that settles them.
 * The door answers each ask once, through dialogs the caller hands in, so
 * this module holds the rules and none of the page. */

import type { Wording } from "#shared/scanner-words.ts";
import type { AnswerOf, ScanAnswer } from "./scan-answer.ts";
import type { Say } from "./scanner-messages.ts";

/** What the door answered so far for one scan. */
export type Given = { force?: true; id_verified?: true; quantity?: number };

/** Post one scan with every answer the door gave so far, and answer the
 * door's word for it. */
export type ScanPost = (given: Given) => Promise<ScanAnswer>;

/** How a page talks to the door: its words, and where it reports. */
export type Voice = { say: Say; wording: Wording };

/** The overlays a scan's asks open: a yes-or-no question, and a pick of
 * how many places to admit. The page hands in its own. A test hands in
 * answers. */
export type Dialogs = {
  confirm: (text: string) => Promise<boolean>;
  quantity: (
    max: number,
    text: string,
    ticketCount: (count: number) => string,
  ) => Promise<number | null>;
};

/** A door that can be asked: its voice and its dialogs. */
export type AskingDoor = Voice & { dialogs: Dialogs };

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
  { dialogs, say, wording }: AskingDoor,
): Promise<Given | null> => {
  const decline = (text: string): null => {
    say(text, ask.status === "verify_id" ? "error" : "warning");
    return null;
  };
  const skipped = wording.fill("skipped", { name: ask.name });
  if (ask.status === "wrong_listing") {
    const confirmed = await dialogs.confirm(
      wording.fill("wrongListingConfirm", {
        listingName: ask.listingName,
        name: ask.name,
      }),
    );
    return confirmed ? { force: true } : decline(skipped);
  }
  if (ask.status === "verify_id") {
    const confirmed = await dialogs.confirm(
      wording.fill("verifyIdConfirm", { name: ask.name }),
    );
    return confirmed
      ? { id_verified: true }
      : decline(wording.fill("idMismatch", { name: ask.name }));
  }
  const count = await dialogs.quantity(
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
  door: AskingDoor,
): Promise<Settled> => {
  const settleFrom = async (
    answer: ScanAnswer,
    given: Given,
  ): Promise<Settled> => {
    const ask = pendingAskOrNull(answer, asks, given);
    if (ask === null) return { answer, declined: false };
    const choice = await askDoor(ask, door);
    if (choice === null) return { answer: ask, declined: true };
    const next = { ...given, ...choice };
    return settleFrom(await post(next), next);
  };
  return settleFrom(await post({}), {});
};

/** The questions a camera scan lets the door answer: the count, the ID
 * check, and whether to widen the door to the ticket's other listing. */
export const CAMERA_ASKS: readonly AskStatus[] = [
  "select_quantity",
  "verify_id",
  "wrong_listing",
];

/** The questions a manual pick lets the door answer. Its route refuses a
 * ticket for another listing, so the pick never asks to widen the door. */
export const PICK_ASKS: readonly AskStatus[] = ["select_quantity", "verify_id"];

/** The questions a queued check-in lets the door answer when it is sent.
 * The door already picked the count offline, and the ticket matched this
 * door's saved list, so only an ID check can still come back. */
export const QUEUE_ASKS: readonly AskStatus[] = ["verify_id"];
