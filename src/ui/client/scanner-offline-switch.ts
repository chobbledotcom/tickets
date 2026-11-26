/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline mode switch of one scanner door. Offline mode is opt-in. The
// door's ticket list downloads when a person turns the switch on. A page
// load downloads it again while the switch is on.

import type { Wording } from "#shared/scanner-words.ts";
import { NetworkError } from "./dom.ts";
import type { Say } from "./scanner-messages.ts";
import {
  downloadTicketCache,
  readManualMode,
  removeTicketCache,
  writeManualMode,
} from "./scanner-offline.ts";
import { isStoreFull } from "./scanner-storage.ts";

/** Wire one door's switch. `onChange` redraws the banner, the switch, and
 * the queue. `onTurnedOff` settles what the door queued while the switch
 * held the scans. `reportFailure` shows the door a failure this switch has
 * no words for. Returns `refresh`, the download a page load starts while
 * the switch is already on. */
export const wireOfflineSwitch = ({
  cachePath,
  onChange,
  onTurnedOff,
  progress,
  reportFailure,
  say,
  scanPath,
  toggle,
  wording,
}: {
  cachePath: string;
  onChange: () => void;
  onTurnedOff: () => void;
  progress: HTMLElement;
  reportFailure: (error: unknown) => void;
  say: Say;
  scanPath: string;
  toggle: HTMLElement;
  wording: Wording;
}): { refresh: () => void } => {
  /** The running download's stop handle, or null when none runs. */
  const download: { running: AbortController | null } = { running: null };

  const showProgress = (done: number, total: number) => {
    progress.textContent = wording.fill("offlineDownloading", { done, total });
    progress.classList.remove("hidden");
  };

  /** Tell the door why the download kept no list. A stopped download is the
   * switch turning off, so it says nothing. A list too big for this
   * browser's store is removed while arming, so no half-kept list stays
   * behind. A refresh that no longer fits keeps the list the door already
   * holds: a refused write replaces nothing, and the switch stays on. */
  const sayDownloadFailure = (
    stop: AbortController,
    error: unknown,
    arming: boolean,
  ) => {
    if (stop.signal.aborted) return;
    if (error instanceof NetworkError) {
      say(wording.word("offlineDownloadFailed"), "error");
      return;
    }
    if (isStoreFull(error)) {
      if (!arming) {
        say(wording.word("offlineRefreshTooBig"), "warning");
        return;
      }
      removeTicketCache(scanPath);
      say(wording.word("offlineListTooBig"), "error");
      return;
    }
    throw error;
  };

  /** Download the door's list page by page, then turn the switch on. A
   * failed download keeps no list. A door that turns offline mode on stays
   * off. A door already on keeps the list it holds until that list
   * expires. */
  const fetchList = async () => {
    const stop = new AbortController();
    download.running = stop;
    // Whether this download arms a door that is off: a door already on is
    // only refreshing, and its stored list must survive a refused write.
    const arming = !readManualMode(scanPath);
    toggle.setAttribute("aria-busy", "true");
    // The numbers wait for the first page: an empty line cannot read as an
    // empty door while the download is only starting.
    try {
      await downloadTicketCache(cachePath, scanPath, showProgress, stop.signal);
      writeManualMode(scanPath, true);
      say(wording.word("offlineReady"), "success");
    } catch (error) {
      sayDownloadFailure(stop, error, arming);
    } finally {
      if (download.running === stop) download.running = null;
      // A stopped download can end after a new one starts. The new one keeps
      // its own busy state and progress.
      if (download.running === null) {
        toggle.removeAttribute("aria-busy");
        progress.classList.add("hidden");
      }
      onChange();
    }
  };

  const startDownload = () => {
    fetchList().catch(reportFailure);
  };

  /** Stop a running download. Answers whether one was running. */
  const stopDownload = () => {
    const stop = download.running;
    if (stop === null) return false;
    stop.abort();
    download.running = null;
    return true;
  };

  const turnOff = () => {
    writeManualMode(scanPath, false);
    removeTicketCache(scanPath);
    onChange();
    onTurnedOff();
  };

  // A click while the list downloads stops it. A click on a door that is
  // on turns it off. Only a click on an idle door that is off turns it on.
  toggle.addEventListener("click", () => {
    const stopped = stopDownload();
    if (readManualMode(scanPath)) turnOff();
    else if (!stopped) startDownload();
  });

  return {
    refresh: () => {
      if (readManualMode(scanPath) && navigator.onLine) startDownload();
    },
  };
};
