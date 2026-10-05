/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Share buttons on public-page rows. Hand the URL to the browser's share
 * sheet where one exists (mostly phones). Copy it to the clipboard otherwise.
 * Select the link's text when the browser offers neither. */
const COPIED_MS = 2000;

/** How the share sheet answered: it took the URL, the visitor stopped it, or
 * the browser never offered one. A stopped sheet ends the click: the visitor
 * said no, so no copy follows. */
type ShareAnswer = "shared" | "stopped" | "absent";

/** The value, or a fallback when it is absent. */
const valueOr = (
  value: string | null | undefined,
  fallback: string,
): string => {
  if (value === null || value === undefined) return fallback;
  return value;
};

/** Run one share action when the browser offers the capability. A refusal or
 * a failed action reports as not done, so the click falls through to the next
 * way of sharing. */
const whenOffered = async (
  offered: boolean,
  action: () => Promise<void>,
): Promise<boolean> => {
  if (!offered) return false;
  try {
    await action();
    return true;
  } catch {
    return false;
  }
};

const copyUrl = (url: string): Promise<boolean> =>
  whenOffered(Boolean(navigator.clipboard), () =>
    navigator.clipboard.writeText(url),
  );

const shareUrl = async (url: string): Promise<ShareAnswer> => {
  if (!navigator.share) return "absent";
  try {
    await navigator.share({ url });
    return "shared";
  } catch (error) {
    // The Web Share spec rejects a cancelled sheet with an AbortError. The
    // visitor stopped the share, so the click ends without a copy.
    if (error instanceof DOMException && error.name === "AbortError") {
      return "stopped";
    }
    return "absent";
  }
};

/** Give the row's link text a selection, so a manual copy needs one
 * right-click. The link shows the full URL, so the copy carries one too.
 * Works where the share sheet and the clipboard both refuse. */
const selectLink = (button: HTMLButtonElement): void => {
  const link = button.closest(".share-row")?.querySelector("[data-share-link]");
  if (!link) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.selectAllChildren(link);
};

/** Swap the button to its copied label for a moment, then back. The original
 * label is captured once, so a click during the flash restores it. */
const flashCopied = (button: HTMLButtonElement): void => {
  if (button.dataset.copiedTimer)
    clearTimeout(Number(button.dataset.copiedTimer));
  if (button.dataset.originalLabel === undefined) {
    button.dataset.originalLabel = valueOr(button.textContent, "");
  }
  button.textContent = valueOr(button.dataset.copiedLabel, "Copied");
  button.dataset.copiedTimer = String(
    setTimeout(() => {
      button.textContent = valueOr(button.dataset.originalLabel, "");
      delete button.dataset.copiedTimer;
    }, COPIED_MS),
  );
};

/** One Share click: the share sheet first, the clipboard second, the link
 * selection when the browser offers neither. A cancelled share sheet ends
 * the click; the clipboard takes over only on a failed share attempt. The
 * wiring only hands over buttons that carry a share URL. */
const shareOrCopy = async (button: HTMLButtonElement): Promise<void> => {
  const url = valueOr(button.getAttribute("data-share-url"), "");
  if ((await shareUrl(url)) !== "absent") return;
  if (await copyUrl(url)) flashCopied(button);
  else selectLink(button);
};

export const initShareButtons = (): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "button[data-share-url]",
  )) {
    button.addEventListener("click", () => {
      void shareOrCopy(button);
    });
  }
};
