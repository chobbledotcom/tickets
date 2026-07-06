/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Anchor the page to a *fresh* validation error after a form submit
 * re-renders it.
 *
 * When a submit fails validation the server re-renders the page with the error
 * still shown, but the browser leaves the operator scrolled at the top — so an
 * error further down the form (e.g. the missing start date on the attendee
 * booking form) is easy to miss. This brings the newly-raised error into view.
 *
 * Two things make it precise:
 *
 * - It only runs after a real submit. A `submit` listener records the errors
 *   already on the page (in `sessionStorage`) just before the form is sent;
 *   the next load reads that snapshot back. A plain page load has no snapshot,
 *   so nothing scrolls. Client-cancelled submits (a form that calls
 *   `preventDefault` to post via fetch, like the scanner) are ignored, so they
 *   don't leave a stale snapshot behind.
 *
 * - It scrolls to the *first error that wasn't already there*. Some forms carry
 *   a standing note styled as `.error[role="alert"]` (e.g. the money-ledger
 *   caution on the attendee form, rendered above the date field). Diffing
 *   against the pre-submit snapshot skips those and lands on the actual
 *   validation error the submit produced.
 *
 * Smoothness is inherited from the page's CSS `scroll-behavior`, which is set
 * to `auto` under `prefers-reduced-motion: reduce`, so this honours the motion
 * preference without a JS media query. */

const SNAPSHOT_KEY = "tickets:submit-errors";

/** Every error alert currently on the page. */
const errorAlerts = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.error[role="alert"]'));

/** A stable signature for an alert — its trimmed text is enough to tell a
 * standing note apart from a freshly-raised validation error. An element's
 * `textContent` is always a string (never null), so trim it directly. */
const signatureOf = (alert: HTMLElement): string => alert.textContent!.trim();

/** Should the fresh alert be scrolled to? True only when it is not already
 * fully within the viewport — an error already on screen (e.g. one at the top
 * of the form) is left where it is rather than nudged to the middle. */
export const errorAlertNeedsScroll = (
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean => top < 0 || bottom > viewportHeight;

/** Just before a real submit, record the errors already showing so the next
 * render can tell which are new. Ignores client-cancelled submits (the form
 * handled it itself, no re-render is coming) and swallows the rare
 * `sessionStorage` failure — the scroll is a pure enhancement. */
const rememberErrorsOnSubmit = (event: Event): void => {
  if (event.defaultPrevented) return;
  try {
    const signatures = errorAlerts().map(signatureOf);
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(signatures));
  } catch {
    // Storage unavailable: the scroll simply won't run — no harm done.
  }
};

/** Read and clear the pre-submit snapshot; null when this load followed no
 * submit, or `sessionStorage` is unavailable. */
const takeSnapshot = (): string[] | null => {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(SNAPSHOT_KEY);
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
};

export const initScrollToError = (): void => {
  // Submit events bubble to the document; no handler in the app stops them, so
  // the default (bubble) phase reliably catches every form send.
  document.addEventListener("submit", rememberErrorsOnSubmit);
  const before = takeSnapshot();
  if (before === null) return; // this load did not follow a submit
  const wasThereBefore = new Set(before);
  const fresh = errorAlerts().find(
    (alert) => !wasThereBefore.has(signatureOf(alert)),
  );
  if (!fresh) return; // nothing new — e.g. the submit actually succeeded
  const { top, bottom } = fresh.getBoundingClientRect();
  if (errorAlertNeedsScroll(top, bottom, window.innerHeight)) {
    fresh.scrollIntoView({ block: "center" });
  }
};
