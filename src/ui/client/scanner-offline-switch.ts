/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline mode switch of one scanner door. Offline mode is opt-in. The
// door's ticket list downloads when a person turns the switch on. A page
// load downloads it again while the switch is on.

import { getMessage, interpolate, showStatus } from "./scanner-messages.js";
import {
  downloadTicketCache,
  readManualMode,
  removeTicketCache,
  writeManualMode,
} from "./scanner-offline.ts";

/** Show one status line in the page's own words. */
const say = (
  statusEl: HTMLElement,
  messages: DOMStringMap,
  key: string,
  fallback: string,
  type: "success" | "error",
): void => showStatus(statusEl, getMessage(messages, key, fallback), type);

/** Wire one door's switch. `onChange` redraws the banner, the switch, and the queue.
 * `onTurnedOff` settles what the door queued while the switch held the
 * scans. Returns `refresh`, the download a page load starts while the
 * switch is already on. */
export const wireOfflineSwitch = ({
  messages,
  onChange,
  onTurnedOff,
  progress,
  scanPath,
  statusEl,
  toggle,
}: {
  messages: DOMStringMap;
  onChange: () => void;
  onTurnedOff: () => void;
  progress: HTMLElement;
  scanPath: string;
  statusEl: HTMLElement;
  toggle: HTMLElement;
}): { refresh: () => void } => {
  /** The running download's stop handle, or null when none runs. */
  let running: AbortController | null = null;

  const showProgress = (done: number, total: number) => {
    progress.textContent = interpolate(
      getMessage(
        messages,
        "messageOfflineDownloading",
        "Downloading the ticket list ({done} of {total} people)",
      ),
      { done, total },
    );
  };

  /** Keep the list the download stored: turn the switch on, or drop the
   * list when the store refuses the switch. */
  const keepDownloadedList = () => {
    if (writeManualMode(scanPath, true)) {
      say(
        statusEl,
        messages,
        "messageOfflineReady",
        "Offline mode is on. The ticket list is saved on this device.",
        "success",
      );
      return;
    }
    removeTicketCache(scanPath);
    say(
      statusEl,
      messages,
      "messageOfflineModeSaveFailed",
      "Your change was not saved. Free up space on this device, then try again.",
      "error",
    );
  };

  /** Download the door's list page by page. A failed download stores
   * nothing. A door that turns offline mode on stays off. A door already on
   * keeps the list it holds until that list expires. */
  const download = async () => {
    const stop = new AbortController();
    running = stop;
    toggle.setAttribute("aria-busy", "true");
    progress.classList.remove("hidden");
    showProgress(0, 0);
    try {
      await downloadTicketCache(scanPath, showProgress, stop.signal);
      keepDownloadedList();
    } catch {
      // A stopped download is the switch turning off: say nothing.
      if (!stop.signal.aborted) {
        say(
          statusEl,
          messages,
          "messageOfflineDownloadFailed",
          "The ticket list did not download. Check your connection, then try again.",
          "error",
        );
      }
    } finally {
      if (running === stop) running = null;
      // A stopped download can end after a new one starts. The new one keeps
      // its own busy state and progress.
      if (running === null) {
        toggle.removeAttribute("aria-busy");
        progress.classList.add("hidden");
      }
      onChange();
    }
  };

  /** Stop a running download. Answers whether one was running. */
  const stopDownload = () => {
    if (!running) return false;
    running.abort();
    running = null;
    return true;
  };

  const turnOff = () => {
    if (!writeManualMode(scanPath, false)) {
      say(
        statusEl,
        messages,
        "messageOfflineModeSaveFailed",
        "Your change was not saved. Free up space on this device, then try again.",
        "error",
      );
      return;
    }
    removeTicketCache(scanPath);
    onChange();
    onTurnedOff();
  };

  // A click while the list downloads stops it. A click on a door that is
  // on turns it off. Only a click on an idle door that is off turns it on.
  toggle.addEventListener("click", () => {
    const stopped = stopDownload();
    if (readManualMode(scanPath)) turnOff();
    else if (!stopped) download();
  });

  return {
    refresh: () => {
      if (readManualMode(scanPath) && navigator.onLine) download();
    },
  };
};
