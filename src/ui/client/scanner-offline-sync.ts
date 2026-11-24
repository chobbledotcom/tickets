/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The queue panel the offline door reads, and the replay that settles it.
// The panel lists every queued check-in, waiting or settled. The sync sends
// each queued check-in to the door it was scanned at once the connection is
// back. It marks the answer on its own row.

import * as v from "valibot";
import { getMessage, interpolate, showStatus } from "./scanner-messages.js";
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

/** What a queued check-in's delivery answers, as far as the queue reads
 * it. An answer with no status is no scan decision: an expired session or
 * a refused role leaves the check-in queued. */
const QueueAnswerSchema = v.object({
  message: v.optional(v.string(), ""),
  name: v.optional(v.string()),
  overAdmission: v.optional(
    v.object({ admitted: v.number(), bought: v.number(), named: v.number() }),
  ),
  status: v.string(),
});

type QueueAnswer = v.InferOutput<typeof QueueAnswerSchema>;

/** Post one queued check-in's delivery and answer the door's final word. */
export type SettleDelivery = (item: QueuedCheckIn) => Promise<unknown>;

/** The message key and fallback words for each answer status a settled
 * row names. */
/* jscpd:ignore-start -- static data, not code */
const QUEUE_OUTCOME_WORDS: Partial<Record<string, [string, string]>> = {
  already_checked_in: ["messageQueueItemAlready", "Was already checked in"],
  checked_in: ["messageQueueItemCheckedIn", "Checked in"],
  not_found: ["messageNotFound", "Ticket not found"],
  refunded: ["messageQueueItemRefunded", "Refunded — not checked in"],
  wrong_listing: ["messageNoDoor", "This ticket has no door to check in at"],
};
/* jscpd:ignore-end */

/** The words a settled queue row carries. A declined ask and a refused
 * ticket read the same way to the door: nobody was checked in. An answer
 * that reports the booking's shortfall alerts the door with the numbers.
 * The door then knows some people got in with no place left. */
const queueOutcome = (messages: DOMStringMap, answer: QueueAnswer): string => {
  if (answer.overAdmission) {
    return interpolate(
      getMessage(
        messages,
        "messageQueueItemOverAdmitted",
        "Alert: {name} — this check-in was for {named}, but the booking only had {admitted} left. The booking holds {bought} in total.",
      ),
      // The alert's numbers ride the answer's over-admission object. The
      // person's name rides the answer itself.
      { ...answer.overAdmission, name: answer.name },
    );
  }
  if (answer.status === "error") return answer.message;
  // verify_id and select_quantity reach the queue only as declined asks, so
  // they and any other status read as nobody checked in.
  const [key, fallback] = QUEUE_OUTCOME_WORDS[answer.status] ?? [
    "messageQueueItemNotCheckedIn",
    "Not checked in",
  ];
  return getMessage(messages, key, fallback);
};

/** The queued count above the panel's rows: what is still pending in the
 * store. Rows stay on the page with their outcome after the sync, so the
 * door sees every result — including which tickets were already checked in
 * elsewhere. */
const renderQueueCount = (panel: QueuePanel, messages: DOMStringMap): void => {
  const count = readQueue().length;
  panel.summary.textContent = interpolate(
    getMessage(
      messages,
      count === 1 ? "messageQueueCountOne" : "messageQueueCountOther",
      "{count} queued check-ins",
    ),
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
  messages: DOMStringMap,
  item: QueuedCheckIn,
): QueueRow => {
  const row = document.createElement("li");
  row.textContent = getMessage(
    messages,
    "messageQueueItemQueued",
    "Waiting — will be checked in when online",
  );
  panel.list.appendChild(row);
  return { item, row };
};

/** Rebuild the queue panel's rows from the stored queue, oldest first. */
export const renderQueuePanel = (
  panel: QueuePanel,
  messages: DOMStringMap,
): void => {
  panel.list.replaceChildren();
  panel.rows = [];
  for (const item of readQueue()) {
    panel.rows.push(queuedRow(panel, messages, item));
  }
  renderQueueCount(panel, messages);
};

/** Add one queued check-in's waiting row without touching the rows already
 * on the panel. A running sync writes its answers to those rows, and the
 * loop settles the appended row too. */
export const appendQueuedRow = (
  panel: QueuePanel,
  messages: DOMStringMap,
  item: QueuedCheckIn,
): void => {
  panel.rows.push(queuedRow(panel, messages, item));
  renderQueueCount(panel, messages);
};

/** A sync asked for while another runs re-runs once the running one ends.
 * The ask that arrives mid-run — a returning connection, a disarm — must
 * not die with the run it interrupted. */
const ask = { again: false };

/** Send every queued check-in and report each one's outcome on its own row.
 * An item leaves the queue only after the door answered it with a scan
 * decision. Nothing is lost when the connection drops mid-sync or the door
 * refuses the page's session. The door answers a replayed check-in
 * with already_checked_in rather than checking anyone in twice. */
export const syncQueue = async (
  statusEl: HTMLElement,
  messages: DOMStringMap,
  panel: QueuePanel,
  settleDelivery: SettleDelivery,
): Promise<void> => {
  if (isSyncing()) {
    ask.again = true;
    return;
  }
  if (!navigator.onLine || readQueue().length === 0) return;
  setSyncing(true);

  /** Drop one answered check-in from the store. False when the store
   * refused the removal, which stops the sync. The door then learns why
   * the row still waits. */
  const dropAnswered = (item: QueuedCheckIn): boolean => {
    try {
      dropFromQueue(item);
    } catch {
      // The door answered, so the check-in is safe, but the store refused
      // the removal. A replay reads as already checked in, so the item
      // stands and the door learns why the row still waits.
      showStatus(
        statusEl,
        getMessage(
          messages,
          "messageQueueSaveFailed",
          "This device could not save the queued check-ins. Free up space, then reload this page.",
        ),
        "error",
      );
      return false;
    }
    return true;
  };

  /** Retire one check-in past the door's replay window: it leaves the
   * store without a send. Its row tells the door to scan the ticket
   * again. False when the store refused the removal, which stops the
   * sync. */
  const expireRow = ({ item, row }: QueueRow): boolean => {
    if (!dropAnswered(item)) return false;
    row.className = "";
    row.textContent = getMessage(
      messages,
      "messageQueueItemExpired",
      "This queued check-in is too old to send. Scan the ticket again while you are online.",
    );
    renderQueueCount(panel, messages);
    return true;
  };

  /** Settle one queued check-in: send its delivery, mark its answer on the
   * row, and drop it from the store. False when the store refused the
   * removal, which stops the sync. */
  const settleRow = async ({ item, row }: QueueRow): Promise<boolean> => {
    let answer: QueueAnswer;
    try {
      answer = v.parse(QueueAnswerSchema, await settleDelivery(item));
    } catch {
      // No answer or no scan decision — a dead connection, an expired
      // session, a refused role. The item waits for the next sync.
      row.textContent = getMessage(
        messages,
        "messageQueueItemStillQueued",
        "Not sent yet — still queued",
      );
      renderQueueCount(panel, messages);
      return true;
    }
    if (!dropAnswered(item)) return false;
    row.textContent = queueOutcome(messages, answer);
    // The over-admission alert must stand out among the settled rows: the
    // door let people in with no place left, and staff act on it now.
    row.className = answer.overAdmission ? "scanner-queue-alert" : "";
    renderQueueCount(panel, messages);
    return true;
  };

  /** The sync's closing words: what the queue's send left behind. */
  const showSyncOutcome = () => {
    const settledAll = readQueue().length === 0;
    showStatus(
      statusEl,
      getMessage(
        messages,
        settledAll ? "messageSyncDone" : "messageSyncStillQueued",
        settledAll
          ? "Queued tickets are done."
          : "Some tickets are still queued. The page will try to check them in again.",
      ),
      settledAll ? "success" : "warning",
    );
  };

  try {
    showStatus(
      statusEl,
      getMessage(
        messages,
        "messageSyncRunning",
        "Checking in queued tickets...",
      ),
      "success",
    );
    // A scan queued after this sync started appended its own row, so the
    // loop settles that item too. A row whose item an earlier run settled
    // left the store: the re-run a mid-sync ask scheduled must not replay
    // its check-in. A check-in past the door's replay window must not be
    // sent: the server's replay record is gone, and a resend admits twice.
    // The row retires without a send.
    for (const pair of panel.rows) {
      if (!queueHolds(pair.item)) continue;
      const settled = deliveryExpired(pair.item, panel.replayWindowMs)
        ? expireRow(pair)
        : await settleRow(pair);
      if (!settled) return;
    }
    showSyncOutcome();
  } finally {
    setSyncing(false);
    if (ask.again) {
      ask.again = false;
      syncQueue(statusEl, messages, panel, settleDelivery);
    }
  }
};
