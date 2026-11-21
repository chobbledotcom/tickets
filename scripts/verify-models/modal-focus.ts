import {
  corruptOneFact,
  integerFields,
  modelDataFor,
  type TlaFact,
} from "#scripts/verify-models/data.ts";
import { matrixModule } from "#scripts/verify-models/modal-lifecycle-matrix.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  dimmingFor,
  EMPTY_SCREEN,
  type ModalFocus,
  type ModalScreen,
  type ScreenEvent,
  transitionScreen,
} from "#src/ui/client/admin/modal-focus.ts";

/** Three window identities show how the top window changes. Every window sits
 * at one point, because this model checks the focus and the dim, not the
 * positions. */
const KEYS = ["a", "b", "c"] as const;
const at = { left: 0, top: 0 };

/** A screen names its windows, bottom first, and who holds the focus. */
const screenOf = (
  focus: ModalFocus,
  ...keys: readonly string[]
): ModalScreen => ({
  focus,
  windows: keys.map((key) => ({ expandedPoint: null, key, point: at })),
});

type FocusEvent = Extract<
  ScreenEvent,
  { type: "open" | "raise" | "close" | "focus-page" }
>;

/** One event of this type for each key. */
const eachKey = (type: "raise" | "close"): FocusEvent[] =>
  KEYS.map((key) => ({ key, type }));

/** Each key opens, rises, and closes. A press on the page comes last. */
export const focusEvents: readonly FocusEvent[] = [
  ...KEYS.map((key): FocusEvent => ({ key, point: at, type: "open" })),
  ...eachKey("raise"),
  ...eachKey("close"),
  { type: "focus-page" },
];

/** `focus` is 0 while the page has it and 1 while the top window has it. A
 * `Dim` field and `pageDim` are 1 for each dim part of the screen. */
const SNAPSHOT_FIELDS = [
  "aDim",
  "aRank",
  "bDim",
  "bRank",
  "cDim",
  "cRank",
  "focus",
  "pageDim",
] as const;
const snapshotFields = integerFields(SNAPSHOT_FIELDS);
const nodeFields = { ...snapshotFields, id: "Int" } as const;
const eventFields = { event: "Int", key: "Str", kind: "Str" } as const;

type FocusSnapshot = TlaFact<typeof snapshotFields>;
type FocusNode = TlaFact<typeof nodeFields>;
export type FocusFacts = {
  readonly edges: readonly { event: number; source: number; target: number }[];
  readonly events: readonly TlaFact<typeof eventFields>[];
  readonly snapshots: readonly FocusNode[];
};

/** The facts of one screen: the rank of each window, the focus, and the dim
 * that the production rule reports for each part. */
export const focusSnapshot = (screen: ModalScreen): FocusSnapshot => {
  const dimming = dimmingFor(screen);
  const rank = (key: string): number =>
    screen.windows.findIndex((window) => window.key === key) + 1;
  const dim = (key: string): number => Number(dimming.windows.has(key));
  if (screen.windows.some(({ key }) => !KEYS.some((known) => known === key))) {
    throw new Error("Unknown window identity in the focus domain");
  }
  return {
    aDim: dim("a"),
    aRank: rank("a"),
    bDim: dim("b"),
    bRank: rank("b"),
    cDim: dim("c"),
    cRank: rank("c"),
    focus: screen.focus === "window" ? 1 : 0,
    pageDim: Number(dimming.page),
  };
};

/** Every order of some of the keys, bottom first, including none. */
const stacksOf = (keys: readonly string[]): string[][] => [
  [],
  ...keys.flatMap((key) =>
    stacksOf(keys.filter((other) => other !== key)).map((rest) => [
      key,
      ...rest,
    ]),
  ),
];

/** The empty screen, and each stack of windows with the page or the top window
 * holding the focus. This is every screen that the selected events reach. */
export const focusDomain: readonly ModalScreen[] = stacksOf(KEYS).flatMap(
  (keys) =>
    keys.length === 0
      ? [EMPTY_SCREEN]
      : (["window", "page"] as const).map((focus) => screenOf(focus, ...keys)),
);

const snapshotKey = (screen: ModalScreen): string =>
  JSON.stringify(focusSnapshot(screen));

/** Every event runs at every screen, including events that change nothing. The
 * observed screen must be one of the declared screens. */
export const focusFacts = (
  transition: typeof transitionScreen = transitionScreen,
): FocusFacts => {
  const ids = new Map(
    focusDomain.map((screen, id): [string, number] => [
      snapshotKey(screen),
      id,
    ]),
  );
  return {
    edges: focusDomain.flatMap((screen, source) =>
      focusEvents.map((event, index) => ({
        event: index,
        source,
        target: requireValue(
          ids.get(snapshotKey(transition(screen, event))),
          "The focus domain does not hold an observed screen",
        ),
      })),
    ),
    events: focusEvents.map((event, index) => ({
      event: index,
      key: event.type === "focus-page" ? "page" : event.key,
      kind: event.type,
    })),
    snapshots: focusDomain.map((screen, id) => ({
      ...focusSnapshot(screen),
      id,
    })),
  };
};

const focusDataWith = (transform: (facts: FocusFacts) => FocusFacts) =>
  modelDataFor(() =>
    matrixModule(
      "ModalFocusData",
      { events: eventFields, snapshots: nodeFields },
      transform(focusFacts()),
    ),
  );

export const modalFocusModelData = focusDataWith((facts) => facts);

const nodeOf = (facts: FocusFacts, screen: ModalScreen): FocusNode => {
  const expected = focusSnapshot(screen);
  return requireValue(
    facts.snapshots.find((row) =>
      SNAPSHOT_FIELDS.every((field) => row[field] === expected[field]),
    ),
    "The focus control found no state to corrupt",
  );
};

/** A control changes the facts around one declared screen, its victim. */
const corruptAt =
  (
    screen: ModalScreen,
    corrupt: (facts: FocusFacts, victim: FocusNode) => Partial<FocusFacts>,
  ) =>
  (facts: FocusFacts): FocusFacts => ({
    ...facts,
    ...corrupt(facts, nodeOf(facts, screen)),
  });

/** Corrupt a domain record: both windows are bright while a window has the
 * focus. Initial safety must detect the second bright part. */
export const twoBrightFocusFacts = corruptAt(
  screenOf("window", "a", "b"),
  (facts, victim) => ({
    snapshots: corruptOneFact(
      facts.snapshots,
      (row) => row.id === victim.id,
      "The focus control found no two-window state",
      (row) => ({ ...row, aDim: 0 }),
    ),
  }),
);

/** Corrupt one press on the page: the window keeps the focus, so the page stays
 * dim. The target is a declared state, so only the focus law can detect it. */
export const stuckFocusFacts = corruptAt(
  screenOf("window", "a"),
  (facts, victim) => {
    const press = requireValue(
      facts.events.find(({ kind }) => kind === "focus-page"),
      "The focus control found no press on the page",
    );
    return {
      edges: corruptOneFact(
        facts.edges,
        (edge) => edge.source === victim.id && edge.event === press.event,
        "The focus control found no press to corrupt",
        (edge) => ({ ...edge, target: victim.id }),
      ),
    };
  },
);

export const twoBrightFocusData = focusDataWith(twoBrightFocusFacts);
export const stuckFocusData = focusDataWith(stuckFocusFacts);
