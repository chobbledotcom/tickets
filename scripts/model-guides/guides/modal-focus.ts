import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of who holds the focus among the admin windows. */
/* jscpd:ignore-start -- static data, not code */
export const modalFocus: ModelGuide = {
  badOutcome:
    "Two parts of the screen are bright at once, the page stays dim after a press on it, or a press on the page moves a window.",
  cast: [
    {
      meaning: "An admin window that leaves the rest of the page usable.",
      term: "modal",
    },
    {
      meaning: "One window identity. The examples use a, b, and c.",
      term: "key",
    },
    {
      meaning:
        "The place of a window in the stack, bottom first. Zero means the window is absent.",
      term: "rank",
    },
    {
      meaning:
        "Who holds the focus. Focus 0 means the page holds it. Focus 1 means the top window holds it. With no window, the page holds it.",
      term: "focus",
    },
    {
      meaning:
        "A part of the screen that is dimmed. The page is dim while a window holds the focus. A window is dim unless it is the top window with the focus.",
      term: "dim",
    },
    {
      meaning:
        "One input to the pure reducer: open, raise, or close of one key, or a press on the page.",
      term: "event",
    },
    {
      meaning:
        "One observed reducer output. The model gives each distinct screen a model-only id.",
      term: "screen",
    },
  ],
  claim:
    "This page follows who holds the focus among the admin windows and the page. Every observed event leaves a valid screen, gives the focus to the right holder, and keeps exactly one part bright.",
  limits: [
    "The examples use three keys and every order of every subset of them. They do not prove other stacks.",
    "The model does not move a window. The ModalLifecycle model checks the order and the position of each window.",
    "The model checks a pure reducer. It does not prove browser focus events, pointer delivery, CSS dimming, or rendered content.",
    "No fairness rule is present. Safety does not prove that a press on the page eventually happens.",
  ],
  module: "ModalFocus",
  safety:
    "Every current screen has a valid stack. The page or the top window holds the focus, the dim matches the focus, and exactly one part of the screen is bright. The initial screen is empty and the retained verdict is true.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/modal-focus.ts",
          symbol: "focusFacts",
        },
        {
          path: "src/ui/client/admin/modal-focus.ts",
          symbol: "transitionScreen",
        },
      ],
      rules: ["Init", "Blank", "Keys", "ScreenIds", "DomainOK"],
      title: "Start with no window",
      values: [
        { name: "screen", value: "0" },
        { name: "safe", value: "TRUE" },
        { name: "focus", value: "0" },
        { name: "pageDim", value: "0" },
        { name: "screen rows", value: "31" },
        { name: "input rows", value: "10" },
        { name: "observed transitions", value: "310" },
      ],
      what: "The model starts before the first open. Blank is the row with id 0, every rank at zero, and the page holding the focus. Keys names a, b, and c. ScreenIds holds every declared screen id. DomainOK checks that row 1 is Blank, that every row id matches its tuple position, and that every screen has one target for each event.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal.ts",
          symbol: "openAdminModal",
        },
        {
          path: "src/ui/client/admin/modal-focus.ts",
          symbol: "transitionScreen",
        },
      ],
      rules: [
        "Transition",
        "LegalMove",
        "FocusLaw",
        "TopLaw",
        "TakesFocus",
        "RankOf",
        "OpenWindows",
        "Snapshot",
      ],
      title: "Open a and take the focus",
      values: [
        { name: "before", value: "no window, focus 0." },
        { name: "after", value: "aRank 1, focus 1, pageDim 1, aDim 0." },
      ],
      what: "An open of a live or absent key puts that window at the top. The window takes the focus from the page. TopLaw requires the opened window to hold the top rank. FocusLaw requires focus 1 after the event. RankOf reads the new place of the key, and OpenWindows counts the open windows. TakesFocus names an open or a raise that leaves its key as a live window. Snapshot reads the source and target rows from the observed screen table.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal.ts",
          symbol: "initAdminModalShell",
        },
        {
          path: "src/ui/client/admin/modal-focus.ts",
          symbol: "dimmingFor",
        },
      ],
      rules: [
        "FocusLaw",
        "PressLaw",
        "DimLaw",
        "ExpectedDim",
        "ExpectedPageDim",
        "BrightCount",
        "Dim",
        "ValidScreen",
      ],
      title: "Press the page and press a window",
      values: [
        { name: "after a press on the page", value: "focus 0, pageDim 0." },
        {
          name: "windows",
          value: "Every window keeps its rank and turns dim.",
        },
        { name: "after a raise of a", value: "focus 1, pageDim 1, aDim 0." },
        { name: "bright parts", value: "Exactly one, in every screen." },
      ],
      what: "A press on the page gives the focus to the page and moves no window. PressLaw requires every rank to stay. FocusLaw requires focus 0 after the press. The page is then bright, and every window is dim. A raise of a window gives it the focus again. Dim reads the dim flag of one window. ExpectedDim and ExpectedPageDim state which parts are dim. BrightCount adds the parts that are not dim, and DimLaw requires exactly one. ValidScreen keeps the flags and the ranks valid.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal.ts",
          symbol: "closeAdminModal",
        },
        {
          path: "src/ui/client/admin/modal-focus.ts",
          symbol: "transitionScreen",
        },
      ],
      rules: ["Transition", "FocusLaw", "OpenWindows", "ValidScreen"],
      title: "Close the last window",
      values: [
        { name: "before", value: "aRank 1, focus 1." },
        { name: "after", value: "no window, focus 0." },
      ],
      what: "A close removes its key and keeps the focus where it was, until the last window closes. The last close gives the focus to the page, because no window can hold it. OpenWindows reads that no window is open. FocusLaw requires focus 0 for that screen, and ValidScreen requires the same for every screen with no window.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/modal-lifecycle-matrix.ts",
          symbol: "modalTargets",
        },
        {
          path: "scripts/verify-models/modal-focus.ts",
          symbol: "modalFocusModelData",
        },
      ],
      rules: ["Next", "Safety", "LegalMove", "DomainOK"],
      title: "Every selected event fits the laws",
      values: [
        { name: "screen rows", value: "31" },
        { name: "input rows", value: "10" },
        { name: "observed transitions", value: "310" },
        {
          name: "target",
          value: "One observed reducer screen id for each source and event.",
        },
        { name: "safe", value: "TRUE" },
      ],
      what: "The producer runs transitionScreen at every declared screen for every selected event. The matrix stores the observed target id. LegalMove checks the stack, the dim, the focus, the top window, and the press for each edge. DomainOK checks the screen and event tables. Safety checks the current id, the retained verdict, and the domain. Next permits any transition or a pause. Safety does not prove that a press on the page eventually happens.",
    },
  ],
  title: "Keep exactly one part of the admin screen bright",
};
/* jscpd:ignore-end */
