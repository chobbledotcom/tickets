import {
  corruptOneFact,
  modelDataFor,
  type TlaFact,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { modalTargets } from "#scripts/verify-models/modal-lifecycle-matrix.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  dimmingFor,
  EMPTY_SCREEN,
  type ModalFocus,
  type ModalScreen,
  type ScreenEvent,
  transitionScreen,
} from "#src/ui/client/admin/modal-focus.ts";
import type { ModalState } from "#src/ui/client/admin/modal-state.ts";

/** Three window identities expose relative survivor order after close.
 * Diagonal points keep the geometry product small. */
const KEYS = ["a", "b", "c"] as const;
const size = { height: 2, width: 2 };
const point = (position: number) => ({ left: position, top: position });
const viewport = (limit: number) => ({ height: limit + 2, width: limit + 2 });

/** The selected events keep three keys for survivor order, two open points
 * for a, one drag clamp, one restore clamp, and one resize clamp. A press on
 * the page comes last, so that the other event numbers stay put. */
export const modalEvents: readonly ScreenEvent[] = [
  { key: "a", point: point(0), type: "open" },
  { key: "a", point: point(2), type: "open" },
  { key: "a", type: "raise" },
  { key: "a", type: "close" },
  { key: "a", type: "minimise" },
  { key: "a", size, type: "restore", viewport: viewport(0) },
  { key: "a", point: point(3), size, type: "move", viewport: viewport(2) },
  { key: "b", point: point(0), type: "open" },
  { key: "b", type: "close" },
  { key: "c", point: point(0), type: "open" },
  { key: "c", type: "close" },
  {
    sizes: new Map(KEYS.map((key) => [key, size])),
    type: "resize",
    viewport: viewport(0),
  },
  { type: "focus-page" },
];

/** `focus` is 0 while the page has the focus and 1 while the top window has
 * it. The `Dim` fields and `pageDim` are 1 for each dim part of the screen. */
const SNAPSHOT_FIELDS = [
  "aDim",
  "aPoint",
  "aRank",
  "aSaved",
  "bDim",
  "bPoint",
  "bRank",
  "bSaved",
  "cDim",
  "cRank",
  "focus",
  "pageDim",
] as const;
const snapshotFields = Object.fromEntries(
  SNAPSHOT_FIELDS.map((field) => [field, "Int"]),
) as Record<(typeof SNAPSHOT_FIELDS)[number], "Int">;
export type ModalSnapshot = TlaFact<typeof snapshotFields>;

const eventFields = {
  event: "Int",
  input: "Int",
  key: "Str",
  kind: "Str",
  limit: "Int",
} as const;

const nodeFields = { ...snapshotFields, id: "Int" } as const;
const edgeFields = { event: "Int", source: "Int", target: "Int" } as const;
export type ModalNode = TlaFact<typeof nodeFields>;
export type ModalInput = TlaFact<typeof eventFields>;
export type ModalEdge = TlaFact<typeof edgeFields>;

const diagonal = (value: { left: number; top: number }): number => {
  if (value.left !== value.top)
    throw new Error("Modal domain left its diagonal");
  return value.left;
};

const modalLocation = (states: readonly ModalState[], key: string) => {
  const state = states.find((current) => current.key === key);
  return {
    point: state ? diagonal(state.point) : -1,
    rank: state ? states.indexOf(state) + 1 : 0,
    saved: state?.expandedPoint ? diagonal(state.expandedPoint) : -1,
  };
};

export const modalSnapshot = (screen: ModalScreen): ModalSnapshot => {
  const states = screen.windows;
  const dimming = dimmingFor(screen);
  const dim = (key: string): number => Number(dimming.windows.has(key));
  const a = modalLocation(states, "a");
  const b = modalLocation(states, "b");
  const c = modalLocation(states, "c");
  if (states.some((state) => !KEYS.some((key) => state.key === key))) {
    throw new Error("Unknown modal identity in finite domain");
  }
  if (
    states.length !==
    Number(a.rank > 0) + Number(b.rank > 0) + Number(c.rank > 0)
  ) {
    throw new Error("Duplicate modal identity in finite domain");
  }
  if (c.saved !== -1 || c.point !== (c.rank === 0 ? -1 : 0)) {
    throw new Error("Stack-only modal changed its fixed expanded position");
  }
  return {
    aDim: dim("a"),
    aPoint: a.point,
    aRank: a.rank,
    aSaved: a.saved,
    bDim: dim("b"),
    bPoint: b.point,
    bRank: b.rank,
    bSaved: b.saved,
    cDim: dim("c"),
    cRank: c.rank,
    focus: screen.focus === "window" ? 1 : 0,
    pageDim: Number(dimming.page),
  };
};

/** The explicit return type makes a new unhandled event a compile error. */
const eventInputs = (
  event: ScreenEvent,
): Omit<ModalInput, "event" | "kind"> => {
  switch (event.type) {
    case "open":
    case "move":
    case "restore":
      return {
        input: event.type === "restore" ? -1 : diagonal(event.point),
        key: event.key,
        limit:
          event.type === "open" ? -1 : event.viewport.width - event.size.width,
      };
    case "resize":
      return {
        input: -1,
        key: "all",
        limit: event.viewport.width - size.width,
      };
    case "raise":
    case "close":
    case "minimise":
      return { input: -1, key: event.key, limit: -1 };
    case "focus-page":
      return { input: -1, key: "page", limit: -1 };
  }
};

export type ModalTransition = typeof transitionScreen;

/** Breadth-first closure, not hand-picked safe edges. Every event runs at every
 * discovered state, including missing keys and duplicate lifecycle actions.
 * An injected production fault must survive projection into the observed facts. */
export const modalLifecycleFacts = (
  transition: ModalTransition = transitionScreen,
) => {
  const empty = modalSnapshot(EMPTY_SCREEN);
  const pending: ModalScreen[] = [EMPTY_SCREEN];
  const snapshots = new Map<string, ModalNode>([
    [JSON.stringify(empty), { ...empty, id: 0 }],
  ]);
  const edges: ModalEdge[] = [];
  for (let source = 0; source < pending.length; source++) {
    const before = pending[source]!;
    for (const [event, input] of modalEvents.entries()) {
      const after = transition(before, input);
      const observed = modalSnapshot(after);
      const identity = JSON.stringify(observed);
      let target = snapshots.get(identity);
      if (target === undefined) {
        if (pending.length >= 300)
          throw new Error("Modal domain is not finite as declared");
        target = { ...observed, id: pending.length };
        snapshots.set(identity, target);
        pending.push(after);
      }
      edges.push({ event, source, target: target.id });
    }
  }
  const events = modalEvents.map(
    (input, event): ModalInput => ({
      ...eventInputs(input),
      event,
      kind: input.type,
    }),
  );
  return { edges, events, snapshots: [...snapshots.values()] };
};

const moduleFor = (facts: ModalFacts): string => {
  const targets = modalTargets(facts);
  return tlaModule("ModalLifecycleData", [
    tlaRecords("Snapshots", nodeFields, facts.snapshots, "Seq"),
    tlaRecords("Events", eventFields, facts.events),
    `\\* @type: Seq(Seq(Int));\nTargets == <<\n${targets
      .map((row) => `<<${row.join(", ")}>>`)
      .join(",\n")}\n>>`,
  ]);
};
export type ModalFacts = {
  readonly snapshots: readonly ModalNode[];
  readonly events: readonly ModalInput[];
  readonly edges: readonly ModalEdge[];
};

const modalDataWith = (transform: (facts: ModalFacts) => ModalFacts) =>
  modelDataFor(() => {
    const facts = transform(modalLifecycleFacts());
    return moduleFor(facts);
  });

/** A control names each window in bottom-first order, not encoded coordinates. */
const expandedWindow = (key: string, position: number): ModalState => ({
  expandedPoint: null,
  key,
  point: point(position),
});

/** A control names the focus owner beside the windows it holds. */
const screenOf = (
  focus: ModalFocus,
  windows: readonly ModalState[],
): ModalScreen => ({ focus, windows });

/** Compare every named before-state field from the shared snapshot schema. */
const matchesSnapshot = (
  expected: ModalSnapshot,
  actual: ModalSnapshot,
): boolean =>
  SNAPSHOT_FIELDS.every((field) => actual[field] === expected[field]);

const corruptEdgeData = (
  event: Pick<ModalInput, "kind" | "key">,
  expected: ModalSnapshot,
  missingMessage: string,
  corrupt: (target: ModalSnapshot) => ModalSnapshot,
) =>
  modalDataWith((facts) => {
    const source = requireValue(
      facts.snapshots.find((row) => matchesSnapshot(expected, row)),
      missingMessage,
    );
    const input = requireValue(
      facts.events.find(
        (row) => row.kind === event.kind && row.key === event.key,
      ),
      missingMessage,
    );
    return {
      ...facts,
      edges: corruptOneFact(
        facts.edges,
        (row) => row.source === source.id && row.event === input.event,
        missingMessage,
        (edge) => {
          const target = requireValue(
            facts.snapshots.find((row) => row.id === edge.target),
            "Missing modal edge target",
          );
          const changed = corrupt(target);
          const replacement = requireValue(
            facts.snapshots.find((row) => matchesSnapshot(changed, row)),
            "Corrupted modal target is outside the declared node domain",
          );
          return { ...edge, target: replacement.id };
        },
      ),
    };
  });

export const modalLifecycleModelData = modalDataWith((facts) => facts);

/** Corrupt a domain record: initial safety must detect duplicate stack ranks. */
export const duplicateRankModalData = modalDataWith((facts) => {
  const expected = modalSnapshot(
    screenOf("window", [expandedWindow("a", 0), expandedWindow("b", 0)]),
  );
  return {
    ...facts,
    snapshots: corruptOneFact(
      facts.snapshots,
      (row) => matchesSnapshot(expected, row),
      "No two-window stack to corrupt",
      (row) => ({ ...row, bRank: 1 }),
    ),
  };
});

/** Corrupt a domain record: both windows of a two-window stack are bright
 * while a window has the focus. Initial safety must detect the second bright
 * thing. */
export const twoBrightWindowsModalData = modalDataWith((facts) => {
  const expected = modalSnapshot(
    screenOf("window", [expandedWindow("a", 0), expandedWindow("b", 0)]),
  );
  return {
    ...facts,
    snapshots: corruptOneFact(
      facts.snapshots,
      (row) => matchesSnapshot(expected, row),
      "No two-window stack to corrupt",
      (row) => ({ ...row, aDim: 0 }),
    ),
  };
});

/** Corrupt one observed minimise: it forgets the expanded position. */
export const forgottenPositionModalData = corruptEdgeData(
  { key: "a", kind: "minimise" },
  modalSnapshot(screenOf("window", [expandedWindow("a", 2)])),
  "No expanded window to corrupt",
  (row) => ({ ...row, aSaved: 0 }),
);

/** Corrupt one press on the page: the window keeps the focus, so the page
 * stays dim. The target is a valid declared state, so only the focus law can
 * detect this step fault. */
export const stuckWindowFocusModalData = corruptEdgeData(
  { key: "page", kind: "focus-page" },
  modalSnapshot(screenOf("window", [expandedWindow("a", 0)])),
  "No focused window to corrupt",
  () => modalSnapshot(screenOf("window", [expandedWindow("a", 0)])),
);

/** Closing a leaves b then c, not c then b. The target remains a valid stack,
 * so only the independent order law can detect this focused step fault. */
export const reversedSurvivorsModalData = corruptEdgeData(
  { key: "a", kind: "close" },
  modalSnapshot(
    screenOf("window", [
      expandedWindow("a", 0),
      expandedWindow("b", 0),
      expandedWindow("c", 0),
    ]),
  ),
  "No three-window close to corrupt",
  () =>
    modalSnapshot(
      screenOf("window", [expandedWindow("c", 0), expandedWindow("b", 0)]),
    ),
);
