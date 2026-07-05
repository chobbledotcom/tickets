/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Persist the calendar availability checker's open state across a single
 * navigation.
 *
 * When the operator expands the checker and then clicks a calendar day (or a
 * selected-listing create button), the checker should still be open when the
 * next page loads — but closing it forgets that preference. The flag is written
 * only as the page is being left (`pagehide`), so it is very short-lived, and it
 * is consumed on the next load so it never lingers once the checker is closed.
 */

const STORAGE_KEY = "calendar-availability-open";

export const initAvailabilityChecker = (): void => {
  const details = document.querySelector<HTMLDetailsElement>(
    "[data-availability-checker]",
  );
  if (!details) return;

  // Restore + consume: a flag set on the previous navigation re-opens the
  // checker, then is cleared so closing it later genuinely forgets it.
  if (localStorage.getItem(STORAGE_KEY) === "1") {
    details.open = true;
    localStorage.removeItem(STORAGE_KEY);
  }

  // Closing forgets the preference immediately.
  details.addEventListener("toggle", () => {
    if (!details.open) localStorage.removeItem(STORAGE_KEY);
  });

  // Re-arm only as we navigate away, and only while still open.
  globalThis.addEventListener("pagehide", () => {
    if (details.open) localStorage.setItem(STORAGE_KEY, "1");
  });
};
