/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The queue panel the offline door reads, and the replay that settles it.
// The panel lists every queued check-in, waiting or settled. The sync sends
// each queued check-in to the door it was scanned at once the connection is
// back. It marks the answer on its own row.

import type { ScanAnswer } from "./scanner-answer.ts";
import {
  formatMessage,
  getMessage,
  type Messages,
  showStatus,
} from "./scanner-messages.ts";
import {
  deliveryExpired,
  dropFromQueue,
  isSyncing,
  type QueuedCheckIn,
  queueHolds,
  readQueue,
  setSyncing,
} from "./scanner-offline.ts";

/** One queued check-in's row on the panel, paired with its stored item. */
export type QueueRow = { item: QueuedCheckIn; row: HTMLLIElement };

/** The offline door's queue panel and what the door needs to settle it. */
export type QueuePanel = {
  container: HTMLElement;
  doorKey: Uint8Array;
  list: HTMLElement;
  replayWindowMs: number;
  rows: QueueRow[];
  summary: HTMLElement;
  /** The queue's sync, wired to this page's door. */
  sync: () => Promise<void>;
};

/** Posts one queued check-in and answers the door's final word for it. */
export type SettleDelivery = (item: QueuedCheckIn) => Promise<ScanAnswer>;

/** The message key and fallback words of each settled status's row. */
type Words = readonly [key: string, fallback: string];

const OUTCOME_WORDS: Partial<Record<ScanAnswer["status"], Words>> = {
  already_checked_in: ["messageQueueItemAlready", "Was already checked in"],
  checked_in: ["messageQueueItemCheckedIn", "Checked in"],
  not_found: ["messageNotFound", "Ticket not found"],
  refunded: ["messageQueueItemRefunded", "Refunded — not checked in"],
  wrong_listing: ["messageNoDoor", "This ticket has no door to check in at"],
};

/** The row words for a status with none of its own. The ID check and the
 * quantity ask reach the queue only as declined asks. */
const NOT_CHECKED_IN_WORDS: Words = [
  "messageQueueItemNotCheckedIn",
  "Not checked in",
];

/** The words a settled queue row carries. A declined ask and a refused
 * ticket read the same way to the door: nobody was checked in. An answer
 * that reports the booking's shortfall alerts the door with the numbers.
 * The door then knows some people got in with no place left. */
const queueOutcome = (messages: Messages, answer: ScanAnswer): string => {
  if ("overAdmission" in answer && answer.overAdmission) {
    return formatMessage(
      messages,
      "messageQueueItemOverAdmitted",
      "Alert: {name} — this check-in was for {named}, but the booking only had {admitted} left. The booking holds {bought} in total.",
      // The alert's numbers ride the answer's over-admission object. The
      // person's name rides the answer itself.
      {
        admitted: answer.overAdmission.admitted,
        bought: answer.overAdmission.bought,
        name: answer.name,
        named: answer.overAdmission.named,
      },
    );
  }
  if (answer.status === "error") return answer.message;
  const [key, fallback] = OUTCOME_WORDS[answer.status] ?? NOT_CHECKED_IN_WORDS;
  return getMessage(messages, key, fallback);
};

/** The queued count above the panel's rows: what is still pending in the
 * store. Rows stay on the page with their outcome after the sync, so the
 * door sees every result — including which tickets were already checked in
 * elsewhere. */
const renderQueueCount = (panel: QueuePanel, messages: Messages): void => {
  const count = readQueue().length;
  panel.summary.textContent = formatMessage(
    messages,
    count === 1 ? "messageQueueCountOne" : "messageQueueCountOther",
    "{count} queued check-ins",
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
  messages: Messages,
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
  messages: Messages,
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
  messages: Messages,
  item: QueuedCheckIn,
): void => {
  panel.rows.push(queuedRow(panel, messages, item));
  renderQueueCount(panel, messages);
};

/** A sync asked for while another runs re-runs once the running one ends.
 * The ask that arrives mid-run — a returning connection, a disarm — must
 * not die with the run it interrupted. */
let syncRequested = false;

/** Send every queued check-in and report each one's outcome on its own row.
 * An item leaves the queue only after the door answered it with a scan
 * decision. Nothing is lost when the connection drops mid-sync or the door
 * refuses the page's session. The door answers a replayed check-in
 * with already_checked_in rather than checking anyone in twice. */
export const syncQueue = async (
  statusEl: HTMLElement,
  messages: Messages,
  panel: QueuePanel,
  settleDelivery: SettleDelivery,
): Promise<void> => {
  if (isSyncing()) {
    syncRequested = true;
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
    let answer: ScanAnswer;
    try {
      answer = await settleDelivery(item);
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
    row.className =
      "overAdmission" in answer && answer.overAdmission
        ? "scanner-queue-alert"
        : "";
    renderQueueCount(panel, messages);
    return true;
  };

  /** The sync's closing words: what the queue's send left behind. */
  const showSyncOutcome = (): void => {
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
    if (syncRequested) {
      syncRequested = false;
      syncQueue(statusEl, messages, panel, settleDelivery);
    }
  }
};
