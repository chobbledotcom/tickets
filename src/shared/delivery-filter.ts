/**
 * The calendar's "by delivery agent" filter: the filter value, parsing a raw
 * query param into it, matching a booking's assignment against it, and the
 * rendered "Agent: All / None / Van 1 / …" bar. Mirrors the listing-type filter
 * so the calendar drives the same kind of control.
 */

import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import type { DeliveryAgent } from "#shared/types.ts";

/** Filter value: "all", "none" (no agent assigned), or a specific agent id. */
export type AgentFilter = "all" | "none" | number;

/** Parse a raw `?agent=` value: "none", a known agent id, else "all". */
export const parseAgentFilter = (
  raw: string | null,
  agentIds: ReadonlySet<number>,
): AgentFilter => {
  if (raw === "none") return "none";
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && agentIds.has(n) ? n : "all";
};

/** The query-param string for a filter value ("" means omit it / all). */
export const agentFilterParam = (filter: AgentFilter): string =>
  filter === "all" ? "" : String(filter);

/**
 * Whether a booking's drop-off/collection pair matches the active filter:
 * everything for "all", an unassigned pair for "none", and either side equal
 * to the chosen agent for a specific id.
 */
export const assignmentMatchesAgentFilter = (
  filter: AgentFilter,
  dropOffAgentId: number | null,
  collectionAgentId: number | null,
): boolean => {
  if (filter === "all") return true;
  if (filter === "none")
    return dropOffAgentId === null && collectionAgentId === null;
  return dropOffAgentId === filter || collectionAgentId === filter;
};

/**
 * Render the "Agent: All / None / …" filter as a paragraph of links. The active
 * option is bold + underlined; the rest link via `hrefFor`.
 */
export const renderAgentFilter = (
  active: AgentFilter,
  agents: readonly DeliveryAgent[],
  hrefFor: (f: AgentFilter) => string,
): string => {
  const options: { filter: AgentFilter; label: string }[] = [
    { filter: "all", label: "All" },
    { filter: "none", label: "None" },
    ...agents.map((a) => ({ filter: a.id, label: a.name })),
  ];
  const links = options
    .map(({ filter, label }) => {
      const safe = escapeHtml(label);
      return filter === active
        ? `<strong><u>${safe}</u></strong>`
        : `<a href="${hrefFor(filter)}">${safe}</a>`;
    })
    .join(" / ");
  return `<p class="type-filter">Agent: ${links}</p>`;
};
