import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AgentFilter,
  agentFilterParam,
  assignmentMatchesAgentFilter,
  parseAgentFilter,
  renderAgentFilter,
} from "#shared/delivery-filter.ts";
import type { DeliveryAgent } from "#shared/types.ts";

const agents: DeliveryAgent[] = [
  { id: 1, name: "Van 1" },
  { id: 2, name: "Van 2" },
];
const agentIds = new Set([1, 2]);

describe("delivery-filter parseAgentFilter", () => {
  test("defaults to all for null/blank/unknown values", () => {
    expect(parseAgentFilter(null, agentIds)).toBe("all");
    expect(parseAgentFilter("", agentIds)).toBe("all");
    expect(parseAgentFilter("nope", agentIds)).toBe("all");
    expect(parseAgentFilter("999", agentIds)).toBe("all");
  });

  test("parses none", () => {
    expect(parseAgentFilter("none", agentIds)).toBe("none");
  });

  test("parses a known agent id", () => {
    expect(parseAgentFilter("2", agentIds)).toBe(2);
  });
});

describe("delivery-filter agentFilterParam", () => {
  test("all yields an empty (omitted) param", () => {
    expect(agentFilterParam("all")).toBe("");
  });

  test("none and ids serialize to their string", () => {
    expect(agentFilterParam("none")).toBe("none");
    expect(agentFilterParam(3)).toBe("3");
  });
});

describe("delivery-filter assignmentMatchesAgentFilter", () => {
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

describe("delivery-filter renderAgentFilter", () => {
  const href = (f: AgentFilter): string => `/x?agent=${agentFilterParam(f)}`;

  test("renders All / None / each agent with the active one bold", () => {
    const html = renderAgentFilter(1, agents, href);
    expect(html).toContain("Agent:");
    expect(html).toContain(">All<");
    expect(html).toContain(">None<");
    // The active agent (id 1) is bold + underlined, not a link.
    expect(html).toContain("<strong><u>Van 1</u></strong>");
    // The inactive agent is a link.
    expect(html).toContain('<a href="/x?agent=2">Van 2</a>');
  });

  test("escapes agent names to prevent HTML injection", () => {
    const html = renderAgentFilter("all", [{ id: 9, name: "<b>x</b>" }], href);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
