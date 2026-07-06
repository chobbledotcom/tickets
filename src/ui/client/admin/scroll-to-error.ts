/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Anchor the page to a freshly-raised validation error after a form submit.
 *
 * When a submit fails validation the server re-renders the page with the error
 * still shown, but the browser leaves the operator scrolled at the top — so an
 * error further down the form (e.g. the missing start date on the attendee
 * booking form) is easy to miss. This brings the newly-raised error into view.
 *
 * The tricky part is telling a *fresh validation error* apart from a *standing
 * note* that some forms render in the same `.error[role="alert"]` style (e.g.
 * the money-ledger caution on the attendee form, which sits above the date
 * field). It does that with a baseline:
 *
 * - On a plain page load (an initial GET, a link, the back button) the alerts
 *   showing are the view's standing notes; they're recorded as the baseline.
 * - On a submit re-render, the error to scroll to is the first alert that is
 *   NOT in that baseline. The baseline is left untouched on submit re-renders,
 *   so an error that persists across a retry (the operator fixed one of two
 *   errors) is still found the next time.
 *
 * Two more guards keep it honest: client-cancelled submits (a form that
 * `preventDefault`s to post via fetch, like the scanner) are ignored so they
 * don't arm a phantom scroll; and a success/info flash means the submit worked
 * — possibly after redirecting to a page with its own standing note — so we
 * don't chase an error there.
 *
 * Smoothness is inherited from the page's CSS `scroll-behavior`, which is set
 * to `auto` under `prefers-reduced-motion: reduce`, so this honours the motion
 * preference without a JS media query. */

const SUBMITTED_KEY = "tickets:form-submitted";
const BASELINE_KEY = "tickets:error-baseline";

/** Every error alert currently on the page. */
const errorAlerts = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.error[role="alert"]'));

/** A stable signature for an alert — its trimmed text is enough to tell a
 * standing note apart from a freshly-raised validation error. An element's
 * `textContent` is always a string (never null), so trim it directly. */
const signatureOf = (alert: HTMLElement): string => alert.textContent!.trim();

/** Read a stored value, or null if unset / `sessionStorage` is unavailable. */
const safeRead = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Run a storage mutation, swallowing the rare unavailable-storage throw
 * (Safari private mode, storage disabled) — the scroll is a pure enhancement. */
const safeWrite = (mutate: (store: Storage) => void): void => {
  try {
    mutate(sessionStorage);
  } catch {
    // Storage unavailable: the scroll simply won't run — no harm done.
  }
};

/** Should the fresh alert be scrolled to? True only when it is not already
 * fully within the viewport — an error already on screen (e.g. one at the top
 * of the form) is left where it is rather than nudged to the middle. */
export const errorAlertNeedsScroll = (
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean => top < 0 || bottom > viewportHeight;

/** On a real (not client-cancelled) submit, record that a submit happened so
 * the next load knows to look for a freshly-raised error. */
const rememberSubmit = (event: Event): void => {
  if (event.defaultPrevented) return;
  safeWrite((store) => store.setItem(SUBMITTED_KEY, "1"));
};

/** The view's standing notes, as captured on the last plain load. */
const standingNotes = (): Set<string> => {
  const raw = safeRead(BASELINE_KEY);
  if (raw === null) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
};

export const initScrollToError = (): void => {
  // Submit events bubble to the document; no handler in the app stops them, so
  // the default (bubble) phase reliably catches every form send.
  document.addEventListener("submit", rememberSubmit);

  const justSubmitted = safeRead(SUBMITTED_KEY) !== null;
  safeWrite((store) => store.removeItem(SUBMITTED_KEY));

  if (!justSubmitted) {
    // Plain load: the alerts showing now are the view's standing notes. Record
    // them as the baseline the next submit re-render diffs against; don't scroll.
    const notes = JSON.stringify(errorAlerts().map(signatureOf));
    safeWrite((store) => store.setItem(BASELINE_KEY, notes));
    return;
  }

  // A success/info flash means the submit worked (and may have redirected to a
  // page carrying its own standing note) — don't chase an error.
  if (document.querySelector('.success[role="alert"], .info[role="alert"]')) {
    return;
  }

  const notes = standingNotes();
  const fresh = errorAlerts().find((alert) => !notes.has(signatureOf(alert)));
  if (!fresh) return; // nothing new — e.g. the submit actually succeeded
  const { top, bottom } = fresh.getBoundingClientRect();
  if (errorAlertNeedsScroll(top, bottom, window.innerHeight)) {
    fresh.scrollIntoView({ block: "center" });
  }
};
