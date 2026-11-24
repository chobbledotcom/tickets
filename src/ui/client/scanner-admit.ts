/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-only code - how one scan settles with the door. It holds the scan
// requests, the status line for each answer, and the asks that the door staff
// answer.

import { isRecord } from "#types";
import { showConfirm } from "./confirm-dialog.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import type { ScanAnswer } from "./scanner-answer.ts";
import {
  formatTicketCount,
  getMessage,
  interpolate,
  type Messages,
  showStatus,
} from "./scanner-messages.ts";

/** Whether a parsed body carries a scan decision. An expired session or a
 * refused role answers JSON with no status, and that is no decision. The
 * check reads the status only. The other fields come from the scan API's own
 * JSON, which this repository builds. */
const isScanAnswer = (body: unknown): body is ScanAnswer =>
  isRecord(body) && typeof body.status === "string";

/** The JSON a scan posts: the ticket by token or by stored digest, and the
 * answers the door already gave. */
type ScanRequest = Readonly<Record<string, boolean | number | string>>;

/** The answers the door already gave to this scan's asks. */
type GivenAnswers = {
  force?: boolean;
  idVerified?: boolean;
  quantity?: number;
};

/** POST one JSON body to a scan API. The page names the API by the door it
 * posts to (one listing or a whole group), and the answer comes back as
 * JSON. An answer with no scan decision is no answer. An expired session or
 * a refused role sends one, and the scan reads as a failed request. */
export const postScanBody = async (
  scanPath: string,
  csrfToken: string,
  body: ScanRequest,
): Promise<ScanAnswer> => {
  const res = await fetch(scanPath, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  });

  const answer: unknown = await res.json();
  if (!isScanAnswer(answer)) {
    throw new Error("The door sent no scan decision.");
  }
  return answer;
};

/** POST one live scan — the page names the door it posts to, so the same
 * client serves both. */
export const postScan = (
  scanPath: string,
  token: string,
  csrfToken: string,
  { force, idVerified, quantity }: GivenAnswers = {},
): Promise<ScanAnswer> => {
  const body: Record<string, boolean | number | string> = { token };
  if (force) body.force = true;
  if (idVerified) body.id_verified = true;
  if (quantity) body.quantity = quantity;

  return postScanBody(scanPath, csrfToken, body);
};

/** The person and booking a check-in answer names. */
type NamedBooking = { listingName: string; name: string; quantity: number };

/** Build a "{name} … ({tickets})" status message for a check-in result. */
const nameAndTicketsMessage = (
  messages: Messages,
  key: string,
  fallback: string,
  result: NamedBooking,
): string =>
  interpolate(getMessage(messages, key, fallback), {
    listingName: result.listingName,
    name: result.name,
    tickets: formatTicketCount(messages, result.quantity),
  });

/** Say the door sent this person away without checking them in. */
const skipPerson = (el: HTMLElement, messages: Messages, name: string): void =>
  showStatus(
    el,
    interpolate(getMessage(messages, "messageSkipped", "Skipped {name}"), {
      name,
    }),
    "warning",
  );

/** Handle a scan result and display status */
export const handleResult = (
  el: HTMLElement,
  result: ScanAnswer,
  messages: Messages,
): void => {
  switch (result.status) {
    case "checked_in":
      showStatus(
        el,
        result.total > result.quantity
          ? interpolate(
              getMessage(
                messages,
                "messageCheckedInPartial",
                "{name} checked in for {listingName} ({tickets} of {total} tickets)",
              ),
              {
                listingName: result.listingName,
                name: result.name,
                tickets: result.quantity,
                total: result.total,
              },
            )
          : nameAndTicketsMessage(
              messages,
              "messageCheckedIn",
              "{name} checked in for {listingName} ({tickets})",
              result,
            ),
        "success",
      );
      break;
    case "already_checked_in":
      showStatus(
        el,
        nameAndTicketsMessage(
          messages,
          "messageAlreadyCheckedIn",
          "{name} already checked in for {listingName} ({tickets})",
          result,
        ),
        "warning",
      );
      break;
    case "refunded":
      showStatus(
        el,
        interpolate(
          getMessage(messages, "messageRefunded", "{name} has been refunded"),
          { name: result.name },
        ),
        "error",
      );
      break;
    // Only the forced rescan lands here. The first wrong_listing answer asks
    // before it re-posts, and a ticket whose only rows are "No check-in"
    // answers wrong_listing again.
    case "wrong_listing":
      showStatus(
        el,
        getMessage(
          messages,
          "messageNoDoor",
          "This ticket has no door to check in at.",
        ),
        "error",
      );
      break;
    case "not_found":
      showStatus(
        el,
        getMessage(messages, "messageNotFound", "Ticket not found"),
        "error",
      );
      break;
    case "error":
      showStatus(el, result.message, "error");
      break;
  }
};

/** Ask the door one yes-or-no question in the page's own words. */
const askConfirm = (
  messages: Messages,
  key: string,
  fallback: string,
  values: Readonly<Record<string, number | string | undefined>>,
): Promise<boolean> =>
  showConfirm(interpolate(getMessage(messages, key, fallback), values));

/** Ask the door staff to confirm the person's ID. A decline says the
 * mismatch on the status line and answers the ask's own answer, so the
 * caller can return it. A confirmation answers null, and the caller sends
 * the ID-checked request. */
export const askIdCheck = async (
  statusEl: HTMLElement,
  messages: Messages,
  answer: Extract<ScanAnswer, { status: "verify_id" }>,
): Promise<ScanAnswer | null> => {
  const ok = await askConfirm(
    messages,
    "messageVerifyIdConfirm",
    'Does their ID match "{name}"?',
    { name: answer.name },
  );
  if (ok) return null;
  showStatus(
    statusEl,
    interpolate(
      getMessage(messages, "messageIdMismatch", "ID does not match {name}"),
      { name: answer.name },
    ),
    "error",
  );
  return answer;
};

/** Send the person away, and answer with the ask they declined. */
const declineAsk = (
  statusEl: HTMLElement,
  messages: Messages,
  name: string,
  answer: ScanAnswer,
): ScanAnswer => {
  skipPerson(statusEl, messages, name);
  return answer;
};

type Door = { messages: Messages; statusEl: HTMLElement };

/** Ask whether to check a person in at a door their ticket is not for. A
 * decline answers the ask. A yes answers null, and the scan posts again. */
const askWrongListing = async (
  { messages, statusEl }: Door,
  answer: Extract<ScanAnswer, { status: "wrong_listing" }>,
  given: GivenAnswers,
): Promise<ScanAnswer | null> => {
  const ok = await askConfirm(
    messages,
    "messageWrongListingConfirm",
    '{name} is registered for "{listingName}", not this listing. Check in anyway?',
    { listingName: answer.listingName, name: answer.name },
  );
  if (!ok) return declineAsk(statusEl, messages, answer.name, answer);
  given.force = true;
  return null;
};

/** Ask the door staff to confirm the ID. A decline answers the ask. A yes
 * answers null, and the scan posts again. */
const askVerifyId = async (
  { messages, statusEl }: Door,
  answer: Extract<ScanAnswer, { status: "verify_id" }>,
  given: GivenAnswers,
): Promise<ScanAnswer | null> => {
  const declined = await askIdCheck(statusEl, messages, answer);
  if (declined) return declined;
  given.idVerified = true;
  return null;
};

/** Ask the door staff how many tickets this scan admits. A cancel answers the
 * ask. A pick answers null, and the scan posts again. */
const askQuantity = async (
  { messages, statusEl }: Door,
  answer: Extract<ScanAnswer, { status: "select_quantity" }>,
  given: GivenAnswers,
): Promise<ScanAnswer | null> => {
  const count = await showQuantitySelect(
    answer.max,
    interpolate(
      getMessage(
        messages,
        "messageSelectQuantity",
        "How many tickets for {name}?",
      ),
      { name: answer.name },
    ),
    (count) => formatTicketCount(messages, count),
  );
  if (!count) return declineAsk(statusEl, messages, answer.name, answer);
  given.quantity = count;
  return null;
};

/** Settle one answer: an ask goes to the door staff, and any other answer is
 * the door's final word. An ask the door staff answered yet leaves the scan
 * open answers null. */
const settleAnswer = async (
  door: Door,
  answer: ScanAnswer,
  given: GivenAnswers,
): Promise<ScanAnswer | null> => {
  if (answer.status === "wrong_listing" && !given.force) {
    return askWrongListing(door, answer, given);
  }
  if (answer.status === "verify_id" && !given.idVerified) {
    return askVerifyId(door, answer, given);
  }
  if (answer.status === "select_quantity") {
    return askQuantity(door, answer, given);
  }
  handleResult(door.statusEl, answer, door.messages);
  return answer;
};

/** Scan one token and settle it with the door. Each ask is one confirmation,
 * then one re-POST. A wrong listing widens the door. An ID check confirms the
 * person. A quantity ask picks how many tickets this scan admits. Every later
 * POST carries every answer that the door already gave, so nothing re-asks.
 * The result is the answer that the scan settled on: the door's final word,
 * or the ask that the door staff declined. The offline queue's sync uses it
 * to report each replayed check-in. */
export const admitScan = async (
  scanPath: string,
  token: string,
  csrfToken: string,
  statusEl: HTMLElement,
  messages: Messages,
): Promise<ScanAnswer> => {
  const door = { messages, statusEl };
  const given: GivenAnswers = {};
  let answer = await postScan(scanPath, token, csrfToken);
  while (true) {
    const settled = await settleAnswer(door, answer, given);
    if (settled) return settled;
    answer = await postScan(scanPath, token, csrfToken, given);
  }
};
