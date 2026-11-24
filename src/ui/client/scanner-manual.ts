/// <reference lib="dom" />
/** The scanner page's manual check-in, wired to the page's offline side. */

import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import { offlinePeople, type QueuePanel } from "./scanner-offline-ui.ts";

/** Start the page's manual check-in. `panel` is the offline side's panel, or
 * null when the offline side did not start: the manual check-in then asks
 * the door's search route only. While offline mode settles the door, it
 * searches the saved list and queues its picks through the offline side. */
export const startManualCheckin = (
  scanPath: string,
  messages: DOMStringMap,
  panel: QueuePanel | null,
): void =>
  initManualCheckin(
    panel === null ? null : offlinePeople(scanPath, messages, panel),
  );
