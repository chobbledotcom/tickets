import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AgentFilter,
  agentFilterParam,
  assignmentMatchesAgentFilter,
  parseAgentFilter,
  renderAgentFilter,
} from "#shared/logistics-filter.ts";
import type { LogisticsAgent } from "#types";

const agents: LogisticsAgent[] = [
  { id: 1, name: "Van 1" },
  { id: 2, name: "Van 2" },
];
const agentIds = new Set([1, 2]);

describe("logistics-filter parseAgentFilter", () => {
  test("defaults to all for null/blank/unknown values", () => {
    expect(parseAgentFilter(null, agentIds)).toBe("all");
    expect(parseAgentFilter("", agentIds)).toBe("all");
    expect(parseAgentFilter("nope", agentIds)).toBe("all");
    expect(parseAgentFilter("999", agentIds)).toBe("all");
    expect(parseAgentFilter("2x", agentIds)).toBe("all");
  });

  test("parses none", () => {
    expect(parseAgentFilter("none", agentIds)).toBe("none");
  });

  test("parses a known agent id", () => {
    expect(parseAgentFilter("2", agentIds)).toBe(2);
  });
});

describe("logistics-filter agentFilterParam", () => {
  test("all yields an empty (omitted) param", () => {
    expect(agentFilterParam("all")).toBe("");
  });

  test("none and ids serialize to their string", () => {
    expect(agentFilterParam("none")).toBe("none");
    expect(agentFilterParam(3)).toBe("3");
  });
});

describe("logistics-filter assignmentMatchesAgentFilter", () => {
  test("all matches everything", () => {
    expect(assignmentMatchesAgentFilter("all", null, null)).toBe(true);
    expect(assignmentMatchesAgentFilter("all", 1, 2)).toBe(true);
  });

  test("none matches only unassigned bookings", () => {
    expect(assignmentMatchesAgentFilter("none", null, null)).toBe(true);
    expect(assignmentMatchesAgentFilter("none", 1, null)).toBe(false);
    expect(assignmentMatchesAgentFilter("none", null, 2)).toBe(false);
  });

  test("an id matches either drop-off or collection", () => {
    expect(assignmentMatchesAgentFilter(1, 1, null)).toBe(true);
    expect(assignmentMatchesAgentFilter(1, null, 1)).toBe(true);
    expect(assignmentMatchesAgentFilter(1, 2, 2)).toBe(false);
  });
});

describe("logistics-filter renderAgentFilter", () => {
  const href = (f: AgentFilter): string => `/x?agent=${agentFilterParam(f)}`;

  test("renders All / None / each agent in order, with an agent id active", () => {
    const html = renderAgentFilter(1, agents, href);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        '<a href="/x?agent=">All</a>' +
        ' / <a href="/x?agent=none">None</a>' +
        " / <strong><u>Van 1</u></strong>" +
        ' / <a href="/x?agent=2">Van 2</a>' +
        "</div>",
    );
  });

  test("bolds the All option when it is active", () => {
    const html = renderAgentFilter("all", agents, href);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/x?agent=none">None</a>' +
        ' / <a href="/x?agent=1">Van 1</a>' +
        ' / <a href="/x?agent=2">Van 2</a>' +
        "</div>",
    );
  });

  test("bolds the None option when it is active", () => {
    const html = renderAgentFilter("none", agents, href);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        '<a href="/x?agent=">All</a>' +
        " / <strong><u>None</u></strong>" +
        ' / <a href="/x?agent=1">Van 1</a>' +
        ' / <a href="/x?agent=2">Van 2</a>' +
        "</div>",
    );
  });

  test("renders just All / None when there are no agents", () => {
    const html = renderAgentFilter("all", [], href);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/x?agent=none">None</a>' +
        "</div>",
    );
  });

  test("escapes agent names to prevent HTML injection", () => {
    const html = renderAgentFilter("all", [{ id: 9, name: "<b>x</b>" }], href);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/x?agent=none">None</a>' +
        ' / <a href="/x?agent=9">&lt;b&gt;x&lt;/b&gt;</a>' +
        "</div>",
    );
  });
});
