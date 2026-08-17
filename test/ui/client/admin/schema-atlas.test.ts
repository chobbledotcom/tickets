import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initSchemaAtlas } from "#src/ui/client/admin/schema-atlas.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller(["MouseEvent"]);

afterEach(cleanup);

/** The page body the server renders, reduced to what the widget needs. */
const pageWith = (machinesJson: string): string => `
  <section class="schema-machine" data-schema-atlas-machine="refund">
    <div class="schema-widget" data-schema-atlas="refund" hidden></div>
  </section>
  <script id="schema-atlas-data" type="application/json">${machinesJson}</script>
`;

/**
 * One refund-shaped machine that exercises every path the renderer knows:
 * left-to-right and right-to-left arrows, a self loop, an edge naming a state
 * the machine does not declare, an unknown actor, and a terminal state.
 */
const REFUND_JSON = JSON.stringify({
  machines: [
    {
      id: "refund",
      states: [
        {
          detail: "Everything checks out.",
          edges: [
            {
              actor: "provider",
              label: "The provider proves the money is back",
              to: "returned",
              toLabel: "Money back",
            },
          ],
          id: "ready",
          label: "Ready to send",
          layout: { x: 20, y: 40 },
          start: true,
        },
        {
          detail: "The provider's answer did not settle things.",
          edges: [
            {
              actor: "provider",
              label: "Provider evidence is unclear",
              to: "check",
              toLabel: "Provider check needed",
            },
          ],
          id: "check",
          label: "Provider check needed",
          layout: { x: 300, y: 40 },
          start: false,
        },
        {
          detail: "The provider returned part of the money.",
          edges: [
            {
              actor: "owner",
              label: "You confirm the money came back",
              to: "returned",
              toLabel: "Money back",
            },
            {
              actor: "system",
              label: "an edge to a state that is not declared",
              to: "ghost",
              toLabel: "Ghost",
            },
          ],
          id: "choice_returned",
          label: "Your decision needed: some money is back",
          layout: { x: 580, y: 40 },
          start: false,
        },
        {
          // Stacked directly below the start node: the straight-down arrow.
          detail: "You confirm nothing was sent.",
          edges: [
            {
              actor: "owner",
              label: "You confirm nothing was sent",
              to: "choice_not_sent",
              toLabel: "Your decision needed: nothing was sent",
            },
          ],
          id: "returned",
          label: "Money back",
          layout: { x: 300, y: 200 },
          start: false,
        },
        {
          detail: "The provider shows the refund was never sent.",
          edges: [
            {
              actor: "bank",
              label: "an actor the renderer does not know",
              to: "ready",
              toLabel: "Ready to send",
            },
          ],
          id: "choice_not_sent",
          label: "Your decision needed: nothing was sent",
          layout: { x: 300, y: 360 },
          start: false,
        },
      ],
    },
  ],
});

const mountOf = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-schema-atlas="refund"]');

describe("initSchemaAtlas", () => {
  test("stays inert when the page carries no atlas data", () => {
    const window = installDom("<p>no map here</p>");
    initSchemaAtlas();
    expect(window.document.querySelector("svg")).toBe(null);
  });

  test("draws every declared node and skips edges to undeclared states", () => {
    const window = installDom(pageWith(REFUND_JSON));
    initSchemaAtlas();
    const mount = mountOf();
    expect(mount?.hasAttribute("hidden")).toBe(false);
    const nodes = window.document.querySelectorAll("[data-schema-node]");
    expect(
      [...nodes].map((node) => node.getAttribute("data-schema-node")),
    ).toEqual([
      "ready",
      "check",
      "choice_returned",
      "returned",
      "choice_not_sent",
    ]);
    const edges = window.document.querySelectorAll("[data-schema-from]");
    expect(
      [...edges].map((edge) => edge.getAttribute("data-schema-from")),
    ).toEqual([
      "ready",
      "check",
      "choice_returned",
      "returned",
      "choice_not_sent",
    ]);
    // The unknown actor falls back to the system colour, never no colour.
    expect(
      window.document
        .querySelector('[data-schema-from="choice_not_sent"]')
        ?.getAttribute("class"),
    ).toContain("schema-edge-system");
  });

  test("renders each node completely: label, detail, start badge, arrows", () => {
    const window = installDom(pageWith(REFUND_JSON));
    initSchemaAtlas();
    const ready = window.document.querySelector('[data-schema-node="ready"]')!;
    const label = ready.querySelector("text:not(.schema-node-start)")!;
    expect(label.getAttribute("text-anchor")).toBe("middle");
    expect(label.textContent).toBe("Ready to send");
    expect(ready.querySelector("title")?.textContent).toBe(
      "Everything checks out.",
    );
    // The start badge sits centred above the node it marks.
    const badge = ready.querySelector(".schema-node-start")!;
    expect(badge.getAttribute("text-anchor")).toBe("middle");
    expect(badge.getAttribute("x")).toBe(String(20 + 88));
    expect(badge.getAttribute("y")).toBe(String(40 - 8));
    expect(badge.textContent).toBe("▸");
    // A state with no start marker carries no badge.
    expect(
      window.document
        .querySelector('[data-schema-node="choice_returned"]')
        ?.querySelector(".schema-node-start"),
    ).toBe(null);
    // Every arrow names its machine's own marker so it keeps its head.
    for (const edge of window.document.querySelectorAll("[data-schema-from]")) {
      expect(edge.getAttribute("marker-end")).toBe("url(#schema-arrow-refund)");
    }
  });

  test("choosing a state lights up exactly its own arrows; choosing again clears", () => {
    const window = installDom(pageWith(REFUND_JSON));
    initSchemaAtlas();
    const mount = mountOf()!;
    const readyNode = window.document.querySelector(
      '[data-schema-node="ready"]',
    )!;
    readyNode.dispatchEvent(new window.MouseEvent("click", { bubbles: false }));
    expect(mount.getAttribute("data-schema-selected")).toBe("ready");
    expect(readyNode.getAttribute("data-selected")).toBe("");
    expect(readyNode.getAttribute("aria-pressed")).toBe("true");
    expect(
      window.document
        .querySelector('[data-schema-from="ready"]')
        ?.classList.contains("schema-edge-live"),
    ).toBe(true);
    expect(
      window.document
        .querySelector('[data-schema-from="choice_returned"]')
        ?.classList.contains("schema-edge-live"),
    ).toBe(false);

    readyNode.dispatchEvent(new window.MouseEvent("click", { bubbles: false }));
    expect(mount.hasAttribute("data-schema-selected")).toBe(false);
    expect(readyNode.hasAttribute("data-selected")).toBe(false);
    expect(readyNode.hasAttribute("aria-pressed")).toBe(false);
    expect(window.document.querySelector(".schema-edge-live")).toBe(null);
  });

  test("the keyboard answers for a focused state too", () => {
    const window = installDom(pageWith(REFUND_JSON));
    initSchemaAtlas();
    const mount = mountOf()!;
    const checkNode = window.document.querySelector(
      '[data-schema-node="check"]',
    )!;
    const enter = new window.KeyboardEvent("keydown", {
      cancelable: true,
      key: "Enter",
    });
    checkNode.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(mount.getAttribute("data-schema-selected")).toBe("check");
    // A key that is not Enter or Space changes nothing.
    const other = new window.KeyboardEvent("keydown", {
      cancelable: true,
      key: "Escape",
    });
    checkNode.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(mount.getAttribute("data-schema-selected")).toBe("check");
    // Space answers too — here it toggles the selection back off.
    checkNode.dispatchEvent(new window.KeyboardEvent("keydown", { key: " " }));
    expect(mount.hasAttribute("data-schema-selected")).toBe(false);
  });

  test("a machine with no mount on the page is skipped, not an error", () => {
    const orphan = JSON.stringify({
      machines: [
        {
          id: "orphan",
          states: [
            {
              detail: "d",
              edges: [],
              id: "only",
              label: "Only",
              layout: { x: 0, y: 0 },
              start: true,
            },
          ],
          title: "Not on this page",
        },
      ],
    });
    installDom(pageWith(orphan));
    initSchemaAtlas();
    expect(document.querySelector("svg")).toBe(null);
    expect(mountOf()?.hasAttribute("hidden")).toBe(true);
  });

  test("a mount outside its machine section is left alone", () => {
    installDom(`
      <div class="schema-widget" data-schema-atlas="refund" hidden></div>
      <script id="schema-atlas-data" type="application/json">${REFUND_JSON}</script>
    `);
    initSchemaAtlas();
    const mount = mountOf();
    expect(mount?.hasAttribute("hidden")).toBe(true);
    expect(mount?.children.length).toBe(0);
  });

  test("survives unreadable data without touching the page", () => {
    installDom(pageWith("{not json"));
    initSchemaAtlas();
    expect(document.querySelector("svg")).toBe(null);
    expect(mountOf()?.hasAttribute("hidden")).toBe(true);
  });

  test("an empty data script is inert too", () => {
    installDom(`
      <div class="schema-widget" data-schema-atlas="refund" hidden></div>
      <script id="schema-atlas-data" type="application/json"></script>
    `);
    initSchemaAtlas();
    expect(window.document.querySelector("svg")).toBe(null);
  });
});
