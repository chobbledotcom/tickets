/**
 * The "header actions" row that sits above a table: a labelled bar of filter
 * links, e.g. "Showing: All / Standard / Daily" or "Agent: All / None / Van 1".
 * The active option is bold + underlined; the rest are links. Shared by the
 * listing-type and logistics-agent filters so both render identical markup.
 *
 * Labels are emitted verbatim, so callers must pre-escape any that can contain
 * user input (agent names) — fixed UI labels need no escaping.
 */

/** One option in a filter bar. */
export type FilterBarOption = {
  /** Whether this is the active option (bold + underlined rather than a link). */
  active: boolean;
  /** Display label — pre-escaped by the caller when it can contain user input. */
  label: string;
  /** Target href for the inactive link. */
  href: string;
};

/**
 * Render a labelled filter bar as the `.table-actions` div shown above a table.
 */
export const renderFilterBar = (
  label: string,
  options: readonly FilterBarOption[],
): string => {
  const links = options
    .map((o) =>
      o.active
        ? `<strong><u>${o.label}</u></strong>`
        : `<a href="${o.href}">${o.label}</a>`,
    )
    .join(" / ");
  return `<div class="table-actions">${label}: ${links}</div>`;
};
