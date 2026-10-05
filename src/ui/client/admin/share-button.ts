/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Share buttons on public-page rows. Hand the URL to the browser's share
 * sheet where one exists (mostly phones). Copy it to the clipboard otherwise.
 * Select the link's text when the browser offers neither. */
const COPIED_MS = 2000;

/** Give the row's link text a selection, so a manual copy needs one
 * right-click. Works where the share sheet and the clipboard both refuse. */
const selectLink = (button: HTMLButtonElement): void => {
  const link = button.closest(".share-row")?.querySelector("[data-share-link]");
  if (!link) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.selectAllChildren(link);
};

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

const shareUrl = (url: string): Promise<boolean> =>
  whenOffered(Boolean(navigator.share), () => navigator.share({ url }));

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
 * selection when the browser offers neither. Awaitable so tests meet the
 * whole chain. */
export const shareOrCopy = async (button: HTMLButtonElement): Promise<void> => {
  const url = valueOr(button.getAttribute("data-share-url"), "");
  if (url === "") return;
  if (await shareUrl(url)) return;
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
