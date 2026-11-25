/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-only code - shared wording helpers for the scanner bundle and its
// offline module. The page hands the client its words as `data-message-*`
// attributes. A lookup that misses falls back to the same words the page
// renders.

import { lazyRef } from "#fp";

/** The words the page renders, keyed by their `data-message-*` name. */
export type Messages = Readonly<Record<string, string | undefined>>;

/** The colours a status line shows. */
export type StatusType = "error" | "success" | "warning";

/** The values that fill a message's holes, keyed by hole name. */
type Values = Readonly<Record<string, number | string | undefined>>;

/** Fill a message template's `{name}`-style holes. */
const interpolate = (template: string, values: Values): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

export const getMessage = (
  messages: Messages,
  key: string,
  fallback: string,
): string => messages[key] ?? fallback;

/** One message with its holes filled: the page's own words, or the fallback
 * words when the page carries none. */
export const formatMessage = (
  messages: Messages,
  key: string,
  fallback: string,
  values: Values,
): string => interpolate(getMessage(messages, key, fallback), values);

export const formatTicketCount = (
  messages: Messages,
  count: number,
): string => {
  const safeCount = Number.isFinite(count) ? count : 1;
  const key =
    safeCount === 1 ? "messageTicketCountOne" : "messageTicketCountOther";
  return formatMessage(messages, key, "{count} ticket", { count: safeCount });
};

export const FADE_DELAY_MS = 5000;

const [getFadeTimer, setFadeTimer] = lazyRef(() => 0);

/** Show a status message with color via CSS classes */
export const showStatus = (
  el: HTMLElement,
  message: string,
  type: StatusType,
): void => {
  clearTimeout(getFadeTimer());
  el.textContent = message;
  el.classList.remove(
    "hidden",
    "scanner-status-success",
    "scanner-status-warning",
    "scanner-status-error",
    "scanner-status-fade-out",
  );
  el.classList.add("scanner-status", `scanner-status-${type}`);

  if (type === "success" || type === "warning") {
    setFadeTimer(
      setTimeout(() => {
        el.classList.add("scanner-status-fade-out");
      }, FADE_DELAY_MS),
    );
  }
};
