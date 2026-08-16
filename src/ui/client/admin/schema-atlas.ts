/// <reference lib="dom" />
/**
 * The system-map diagram: reads the JSON the page embedded (labels already
 * resolved server-side) and draws one interactive SVG per machine — click a
 * state to light up its ways forward. The static list below each diagram
 * carries the same facts, so the page is complete without this script.
 */

type PayloadEdge = {
  actor: string;
  label: string;
  to: string;
  toLabel: string;
};
type PayloadState = {
  detail: string;
  edges: PayloadEdge[];
  id: string;
  label: string;
  layout: { x: number; y: number };
  start: boolean;
};
type PayloadMachine = {
  id: string;
  states: PayloadState[];
  title: string;
};

const NODE_W = 176;
const NODE_H = 58;
const ACTOR_CLASS: Record<string, string> = {
  owner: "schema-edge-owner",
  provider: "schema-edge-provider",
  system: "schema-edge-system",
};

const svgTag = (name: string): Element =>
  document.createElementNS("http://www.w3.org/2000/svg", name);

/** One curved arrow from the edge of one node to the edge of another. */
const edgePath = (
  from: PayloadState,
  to: PayloadState,
): { readonly d: string; readonly self: boolean } => {
  if (from.id === to.id) {
    // A self move (a re-arm, another observation): a small loop above.
    const cx = from.layout.x + NODE_W / 2;
    const top = from.layout.y - 14;
    return {
      d: `M ${cx - 26} ${from.layout.y} C ${cx - 46} ${top - 24}, ${cx + 46} ${
        top - 24
      }, ${cx + 26} ${from.layout.y}`,
      self: true,
    };
  }
  const fromCx = from.layout.x + NODE_W / 2;
  const toCx = to.layout.x + NODE_W / 2;
  const fromCy = from.layout.y + NODE_H / 2;
  const toCy = to.layout.y + NODE_H / 2;
  const down = toCy >= fromCy;
  const x1 = fromCx > toCx + NODE_W ? from.layout.x : fromCx;
  const x2 =
    fromCx > toCx + NODE_W
      ? to.layout.x + NODE_W
      : to.layout.x > fromCx + NODE_W
        ? to.layout.x
        : toCx;
  const y1 = down ? from.layout.y + NODE_H : from.layout.y;
  const y2 = down ? to.layout.y : to.layout.y + NODE_H;
  const bend = down ? 26 : -26;
  return {
    d: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
    self: false,
  };
};

const buildMachine = (machine: PayloadMachine): Element => {
  /** The far edge of the diagram along one axis, plus room for labels. */
  const extent = (along: (state: PayloadState) => number): number =>
    Math.max(...machine.states.map(along));
  const width = extent((state) => state.layout.x + NODE_W) + 40;
  const height = extent((state) => state.layout.y + NODE_H) + 90;
  const svg = svgTag("svg");
  svg.setAttribute("class", "schema-map");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", machine.title);

  const defs = svgTag("defs") as SVGDefsElement;
  const marker = svgTag("marker");
  const markerAttrs: Record<string, string> = {
    fill: "context-stroke",
    markerHeight: "6",
    markerWidth: "6",
    orient: "auto",
    refX: "5",
    refY: "3",
    viewBox: "0 0 6 6",
  };
  for (const [key, value] of Object.entries(markerAttrs)) {
    marker.setAttribute(key, value);
  }
  marker.setAttribute("id", `schema-arrow-${machine.id}`);
  marker.appendChild(svgTag("path")).setAttribute("d", "M0,0 L6,3 L0,6 z");
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgesLayer = svgTag("g");
  edgesLayer.setAttribute("data-schema-edges", "");
  svg.appendChild(edgesLayer);

  // Every edge first (they sit under the nodes), one group per source state
  // so selecting a state can highlight exactly its own arrows.
  for (const state of machine.states) {
    for (const edge of state.edges) {
      const target = machine.states.find((other) => other.id === edge.to);
      if (target === undefined) continue;
      const path = svgTag("path");
      path.setAttribute(
        "class",
        `schema-edge ${ACTOR_CLASS[edge.actor] ?? "schema-edge-system"}`,
      );
      path.setAttribute("d", edgePath(state, target).d);
      path.setAttribute("data-schema-from", state.id);
      path.setAttribute("data-schema-to", edge.to);
      path.setAttribute("marker-end", `url(#schema-arrow-${machine.id})`);
      const title = svgTag("title");
      title.textContent = `${edge.label} → ${edge.toLabel}`;
      path.appendChild(title);
      edgesLayer.appendChild(path);
    }
  }

  for (const state of machine.states) {
    const group = svgTag("g");
    group.setAttribute("class", "schema-node");
    group.setAttribute("data-schema-node", state.id);
    group.setAttribute("tabindex", "0");
    const rect = svgTag("rect");
    rect.setAttribute("x", String(state.layout.x));
    rect.setAttribute("y", String(state.layout.y));
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(NODE_H));
    rect.setAttribute("rx", "10");
    group.appendChild(rect);
    const text = svgTag("text");
    text.setAttribute("x", String(state.layout.x + NODE_W / 2));
    text.setAttribute("y", String(state.layout.y + NODE_H / 2 + 4));
    text.setAttribute("text-anchor", "middle");
    text.textContent = state.label;
    group.appendChild(text);
    if (state.start) {
      const badge = svgTag("text");
      badge.setAttribute("class", "schema-node-start");
      badge.setAttribute("x", String(state.layout.x + NODE_W / 2));
      badge.setAttribute("y", String(state.layout.y - 8));
      badge.setAttribute("text-anchor", "middle");
      badge.textContent = "▸";
      group.appendChild(badge);
    }
    const detail = svgTag("title");
    detail.textContent = state.detail;
    group.appendChild(detail);
    svg.append(group);
  }
  return svg;
};

/** Highlight one state's outgoing edges (and dim the rest), or clear. */
const selectState = (
  widget: HTMLElement,
  machineRoot: HTMLElement,
  stateId: string | null,
): void => {
  for (const node of Array.from(
    machineRoot.querySelectorAll("[data-selected]"),
  )) {
    node.removeAttribute("data-selected");
  }
  for (const node of Array.from(widget.querySelectorAll("[aria-pressed]"))) {
    node.removeAttribute("aria-pressed");
  }
  widget.removeAttribute("data-schema-selected");
  for (const edge of Array.from(widget.querySelectorAll(".schema-edge-live"))) {
    edge.classList.remove("schema-edge-live");
  }
  if (stateId === null) return;
  const node = machineRoot.querySelector(`[data-schema-node="${stateId}"]`);
  node?.setAttribute("data-selected", "");
  node?.setAttribute("aria-pressed", "true");
  widget.setAttribute("data-schema-selected", stateId);
  for (const edge of Array.from(
    widget.querySelectorAll(`[data-schema-from="${stateId}"]`),
  )) {
    edge.classList.add("schema-edge-live");
  }
};

/** Mount one machine's diagram into its placeholder. */
const mountMachine = (machine: PayloadMachine): void => {
  const placeholder = document.querySelector<HTMLElement>(
    `[data-schema-atlas="${machine.id}"]`,
  );
  if (placeholder === null) return;
  const machineRoot = placeholder.closest<HTMLElement>(
    "[data-schema-atlas-machine]",
  );
  if (machineRoot === null) return;
  const svg = buildMachine(machine);
  placeholder.append(svg);
  placeholder.removeAttribute("hidden");
  for (const node of Array.from(
    svg.querySelectorAll<HTMLElement>("[data-schema-node]"),
  )) {
    const stateId = node.getAttribute("data-schema-node");
    node.addEventListener("click", () => {
      const already = node.hasAttribute("aria-pressed");
      selectState(placeholder, machineRoot, already ? null : stateId);
    });
    node.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      node.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    });
  }
};

export const initSchemaAtlas = (): void => {
  const data = document.querySelector("#schema-atlas-data");
  if (data === null) return;
  let machines: PayloadMachine[];
  try {
    // String(textContent): a null textContent reads as "null", whose parse
    // cannot carry machines, so the catch answers for it too.
    machines = (
      JSON.parse(String(data.textContent)) as {
        machines: PayloadMachine[];
      }
    ).machines;
  } catch {
    return;
  }
  for (const machine of machines) mountMachine(machine);
};
