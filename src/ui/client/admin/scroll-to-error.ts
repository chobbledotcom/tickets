/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Anchor the page to a validation error after a form submit re-renders it.
 *
 * When a submit fails validation the server re-renders the page with the error
 * still shown, but the browser leaves the operator scrolled at the top — so an
 * error further down the form (e.g. the missing start date on the attendee
 * booking form) is easy to miss. This brings the first error alert into view.
 *
 * It only fires after an actual submit: a `submit` listener records a one-shot
 * flag in `sessionStorage`, and the next page load consumes it. A plain page
 * load (following a link, opening an edit form) never scrolls, so a standing
 * note that happens to be styled as `.error[role="alert"]` — like the
 * money-ledger caution on the attendee form — is never yanked to.
 *
 * A successful submit usually lands on a page carrying a success/info flash;
 * that flash is the signal the action worked, so we skip scrolling even though
 * the flag is set (the destination page may itself carry a standing
 * error-styled note).
 *
 * Smoothness is inherited from the page's CSS `scroll-behavior`, which is set
 * to `auto` under `prefers-reduced-motion: reduce`, so this honours the motion
 * preference without a JS media query. */

const SUBMIT_FLAG = "tickets:form-submitted";

/** Should the first error alert be scrolled to? True only when it is not
 * already fully within the viewport — an error already on screen (e.g. one at
 * the top of the form) is left where it is rather than nudged to the middle. */
export const errorAlertNeedsScroll = (
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean => top < 0 || bottom > viewportHeight;

/** Remember that a form was just submitted, so the next load knows to look for
 * a fresh error. Swallows the rare `sessionStorage` failure (Safari private
 * mode, storage disabled) — the scroll is a pure enhancement. */
const rememberSubmit = (): void => {
  try {
    sessionStorage.setItem(SUBMIT_FLAG, "1");
  } catch {
    // Storage unavailable: the scroll simply won't run — no harm done.
  }
};

/** Read AND clear the one-shot submit flag in one step; null when it was unset
 * or `sessionStorage` is unavailable. */
const takeSubmitFlag = (): string | null => {
  try {
    const flag = sessionStorage.getItem(SUBMIT_FLAG);
    if (flag !== null) sessionStorage.removeItem(SUBMIT_FLAG);
    return flag;
  } catch {
    return null;
  }
};

export const initScrollToError = (): void => {
  // Submit events bubble to the document; no handler in the app stops them, so
  // the default (bubble) phase reliably catches every form send.
  document.addEventListener("submit", rememberSubmit);
  if (takeSubmitFlag() === null) return;
  // A success/info flash means the submit worked — don't chase an error.
  if (document.querySelector('.success[role="alert"], .info[role="alert"]')) {
    return;
  }
  const alert = document.querySelector<HTMLElement>('.error[role="alert"]');
  if (!alert) return;
  const { top, bottom } = alert.getBoundingClientRect();
  if (errorAlertNeedsScroll(top, bottom, window.innerHeight)) {
    alert.scrollIntoView({ block: "center" });
  }
};
