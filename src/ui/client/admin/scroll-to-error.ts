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
 *   A back/forward-cache restore doesn't re-run this script, so a persisted
 *   `pageshow` re-records the baseline too — otherwise it could be left holding
 *   a baseline from a page visited in between.
 * - On a submit re-render, the error to scroll to is the first alert that is
 *   NOT in that baseline. The baseline is left untouched on submit re-renders,
 *   so an error that persists across a retry (the operator fixed one of two
 *   errors) is still found the next time.
 *
 * A few guards keep it honest: only POST submits are tracked (GET filter /
 * navigation forms just navigate and never re-render with validation errors);
 * client-cancelled submits (a form that `preventDefault`s to post via fetch,
 * like the scanner) are ignored; and a success/info flash means the submit
 * worked — possibly after redirecting to a page with its own standing note —
 * so we don't chase an error there.
 *
 * Smoothness is inherited from the page's CSS `scroll-behavior`, which is set
 * to `auto` under `prefers-reduced-motion: reduce`, so this honours the motion
 * preference without a JS media query. */

const SUBMITTED_KEY = "tickets:form-submitted";
const BASELINE_KEY = "tickets:error-baseline";

/** Marks the document (on `<html>`) when this load is a submit re-render. A
 * bfcache restore keeps the frozen DOM, so the mark survives the round-trip and
 * lets a persisted `pageshow` avoid folding a failed submit's validation errors
 * into the standing-note baseline. */
const SUBMIT_RERENDER_ATTR = "data-scroll-submit-rerender";

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

/** Record the alerts showing now as the view's standing notes — the baseline a
 * later submit re-render diffs against. */
const recordBaseline = (): void => {
  const notes = JSON.stringify(errorAlerts().map(signatureOf));
  safeWrite((store) => store.setItem(BASELINE_KEY, notes));
};

/** Should the fresh alert be scrolled to? True only when it is not already
 * fully within the viewport — an error already on screen (e.g. one at the top
 * of the form) is left where it is rather than nudged to the middle. */
export const errorAlertNeedsScroll = (
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean => top < 0 || bottom > viewportHeight;

/** On a real POST submit, record that a submit happened so the next load knows
 * to look for a freshly-raised error. Ignores client-cancelled submits and GET
 * forms (filters, prefill navigation) — neither re-renders with validation
 * errors, so arming the scroll for them would misfire on the next page. */
const rememberSubmit = (event: Event): void => {
  if (event.defaultPrevented) return;
  // A submit event's target is always the form it fired on.
  const form = event.target as HTMLFormElement;
  if (form.method !== "post") return;
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
  // A bfcache restore doesn't re-run this script, so refresh the baseline from
  // the restored page before the operator submits from it — but only if it was
  // a plain page, not a failed-submit re-render (whose validation errors must
  // not be folded into the standing-note baseline, or a retry would miss them).
  window.addEventListener("pageshow", (event) => {
    // Only a *failed* submit re-render (validation errors present) carries the
    // mark; a plain or successful page has standing notes only and is safe to
    // re-baseline from.
    const failedReRender =
      document.documentElement.hasAttribute(SUBMIT_RERENDER_ATTR);
    if ((event as PageTransitionEvent).persisted && !failedReRender) {
      recordBaseline();
    }
  });

  const justSubmitted = safeRead(SUBMITTED_KEY) !== null;
  safeWrite((store) => store.removeItem(SUBMITTED_KEY));

  if (!justSubmitted) {
    // Plain load: the alerts showing now are the view's standing notes. Record
    // them as the baseline the next submit re-render diffs against; don't scroll.
    recordBaseline();
    return;
  }

  // A success/info flash means the submit worked (and may have redirected to a
  // page carrying its own standing note) — don't chase an error. Such a page
  // has only standing notes, so it stays unmarked and a bfcache restore may
  // re-baseline from it.
  if (document.querySelector('.success[role="alert"], .info[role="alert"]')) {
    return;
  }

  // A failed submit re-render carries fresh validation errors: mark it (each
  // load is a fresh document, so the attribute defaults absent) so a bfcache
  // restore won't fold those errors into the standing-note baseline.
  document.documentElement.toggleAttribute(SUBMIT_RERENDER_ATTR, true);
  const notes = standingNotes();
  const fresh = errorAlerts().find((alert) => !notes.has(signatureOf(alert)));
  if (!fresh) return; // nothing new — e.g. the submit actually succeeded
  const { top, bottom } = fresh.getBoundingClientRect();
  if (errorAlertNeedsScroll(top, bottom, window.innerHeight)) {
    fresh.scrollIntoView({ block: "center" });
  }
};
