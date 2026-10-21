// Browser-only code - shared wording helpers for the scanner bundle and its
// offline module. The page hands the client its words as `data-message-*`
// attributes. A lookup that misses falls back to the same words the page
// renders.

/** Fill a message template's `{name}`-style holes. */
export const interpolate = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

export const getMessage = (messages, key, fallback) =>
  messages[key] ?? fallback;

export const formatTicketCount = (messages, count) => {
  const safeCount = Number.isFinite(count) ? count : 1;
  const key =
    safeCount === 1 ? "messageTicketCountOne" : "messageTicketCountOther";
  return interpolate(getMessage(messages, key, "{count} ticket"), {
    count: safeCount,
  });
};

export const FADE_DELAY_MS = 5000;

let fadeTimer = 0;

/** Show a status message with color via CSS classes */
export const showStatus = (el, message, type) => {
  clearTimeout(fadeTimer);
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
    fadeTimer = setTimeout(() => {
      el.classList.add("scanner-status-fade-out");
    }, FADE_DELAY_MS);
  }
};
