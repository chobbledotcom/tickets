/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The queue panel the offline door reads, and the replay that settles it.
// The panel lists every queued check-in, waiting or settled. The sync sends
// each queued check-in to the door it was scanned at once the connection is
// back. It marks the answer on its own row.

import type { PlainWord, Wording } from "#shared/scanner-words.ts";
import { NetworkError } from "./dom.ts";
import type { ScanAnswer } from "./scan-answer.ts";
import type { Say } from "./scanner-messages.ts";
import {
  deliveryExpired,
  dropFromQueue,
  isSyncing,
  type QueuedCheckIn,
  queueHolds,
  readQueue,
  setSyncing,
} from "./scanner-offline.ts";
import type { QueuePanel } from "./scanner-offline-ui.ts";

/** One queue row: the stored check-in and the list item that shows it. */
export type QueueRow = { item: QueuedCheckIn; row: HTMLElement };

/** Post one queued check-in's delivery and answer the door's final word. */
export type SettleDelivery = (item: QueuedCheckIn) => Promise<ScanAnswer>;

/** The words a settled row carries for each answer, or null for an answer
 * that settles nothing: a refusal leaves the check-in queued. A declined
 * ask and a refused ticket read the same way: nobody was checked in. */
/* jscpd:ignore-start -- static data, not code */
const ROW_WORDS: Record<ScanAnswer["status"], PlainWord | null> = {
  already_checked_in: "queueItemAlready",
  checked_in: "queueItemCheckedIn",
  not_found: "notFound",
  other: null,
  refunded: "queueItemRefunded",
  select_quantity: "queueItemNotCheckedIn",
  verify_id: "queueItemNotCheckedIn",
  wrong_listing: "noDoor",
};
/* jscpd:ignore-end */

/** The words a settled row carries. An answer that reports the booking's
 * shortfall alerts the door with the numbers, so the door knows some
 * people got in with no place left. */
const rowOutcome = (
  wording: Wording,
  answer: ScanAnswer,
  word: PlainWord,
): string =>
  "overAdmission" in answer && answer.overAdmission
    ? wording.fill("queueItemOverAdmitted", {
        admitted: answer.overAdmission.admitted,
        bought: answer.overAdmission.bought,
        name: answer.name,
        named: answer.overAdmission.named,
      })
    : wording.word(word);

/** The queued count above the panel's rows: what is still pending in the
 * store. Rows stay on the page with their outcome after the sync, so the
 * door sees every result — including which tickets were already checked in
 * elsewhere. */
const renderQueueCount = (panel: QueuePanel, wording: Wording): void => {
  const count = readQueue().length;
  panel.summary.textContent = wording.fill(
    count === 1 ? "queueCountOne" : "queueCountOther",
    { count },
  );
  panel.container.classList.toggle(
    "hidden",
    count === 0 && panel.rows.length === 0,
  );
};

/** One waiting row for the panel's list, paired with its stored item. */
const queuedRow = (
  panel: QueuePanel,
  wording: Wording,
  item: QueuedCheckIn,
): QueueRow => {
  const row = document.createElement("li");
  row.textContent = wording.word("queueItemQueued");
  panel.list.appendChild(row);
  return { item, row };
};

/** Rebuild the queue panel's rows from the stored queue, oldest first. */
export const renderQueuePanel = (panel: QueuePanel, wording: Wording): void => {
  panel.list.replaceChildren();
  setRows(
    panel,
    wording,
    readQueue().map((item) => queuedRow(panel, wording, item)),
  );
};

/** Show `rows` as the panel's rows, under the queued count. */
const setRows = (panel: QueuePanel, wording: Wording, rows: QueueRow[]) => {
  panel.rows = rows;
  renderQueueCount(panel, wording);
};

/** Add one queued check-in's waiting row without touching the rows already
 * on the panel. A running sync writes its answers to those rows, and the
 * sync settles the appended row too. */
export const appendQueuedRow = (
  panel: QueuePanel,
  wording: Wording,
  item: QueuedCheckIn,
): void =>
  setRows(panel, wording, [...panel.rows, queuedRow(panel, wording, item)]);

/** A sync asked for while another runs re-runs once the running one ends.
 * The ask that arrives mid-run — a returning connection, a disarm — must
 * not die with the run it interrupted. */
const ask = { again: false };

/** Send every queued check-in and report each one's outcome on its own row.
 * An item leaves the queue only after the door answered it with a scan
 * decision. Nothing is lost when the connection drops mid-sync or the door
 * refuses the page's session. The door answers a replayed check-in with
 * already_checked_in rather than checking anyone in twice. */
export const syncQueue = async (
  say: Say,
  wording: Wording,
  panel: QueuePanel,
  settleDelivery: SettleDelivery,
): Promise<void> => {
  if (isSyncing()) {
    ask.again = true;
    return;
  }
  if (!navigator.onLine || readQueue().length === 0) return;
  setSyncing(true);

  /** Retire one check-in past the door's replay window: it leaves the
   * store without a send. Its row tells the door to scan the ticket
   * again. */
  const expireRow = ({ item, row }: QueueRow): void => {
    dropFromQueue(item);
    row.className = "";
    row.textContent = wording.word("queueItemExpired");
  };

  /** The answer to one queued check-in's delivery, or null when it never
   * reached the server. The check-in then waits for the next sync. */
  const answerOrNull = async (item: QueuedCheckIn) => {
    try {
      return await settleDelivery(item);
    } catch (error) {
      if (error instanceof NetworkError) return null;
      throw error;
    }
  };

  /** Settle one queued check-in: send its delivery, mark its answer on the
   * row, and drop it from the store. An answer with no scan decision
   * leaves it queued. */
  const settleRow = async ({ item, row }: QueueRow): Promise<void> => {
    const answer = await answerOrNull(item);
    const word = answer === null ? null : ROW_WORDS[answer.status];
    if (answer === null || word === null) {
      row.textContent = wording.word("queueItemStillQueued");
      return;
    }
    dropFromQueue(item);
    row.textContent = rowOutcome(wording, answer, word);
    // The over-admission alert must stand out among the settled rows: the
    // door let people in with no place left, and staff act on it now.
    row.className =
      "overAdmission" in answer && answer.overAdmission
        ? "scanner-queue-alert"
        : "";
  };

  /** Settle the rows from `index` on. A scan queued after this sync started
   * appended its own row, so the sync settles that item too. A row whose
   * item an earlier run settled left the store: the re-run a mid-sync ask
   * scheduled must not replay its check-in. A check-in past the door's
   * replay window must not be sent: the server's replay record is gone, and
   * a resend admits twice. */
  const settleRowsFrom = async (index: number): Promise<void> => {
    const pair = panel.rows[index];
    if (pair === undefined) return;
    if (queueHolds(pair.item)) {
      if (deliveryExpired(pair.item, panel.replayWindowMs)) expireRow(pair);
      else await settleRow(pair);
      renderQueueCount(panel, wording);
    }
    return settleRowsFrom(index + 1);
  };

  try {
    say(wording.word("syncRunning"), "success");
    await settleRowsFrom(0);
    const settledAll = readQueue().length === 0;
    say(
      wording.word(settledAll ? "syncDone" : "syncStillQueued"),
      settledAll ? "success" : "warning",
    );
  } finally {
    setSyncing(false);
  }
  if (ask.again) {
    ask.again = false;
    await syncQueue(say, wording, panel, settleDelivery);
  }
};
