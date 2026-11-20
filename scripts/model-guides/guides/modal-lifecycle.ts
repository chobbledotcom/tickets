import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of an admin window stack. */
/* jscpd:ignore-start -- static data, not code */
export const modalLifecycle: ModelGuide = {
  badOutcome:
    "A restore forgets the expanded position, a close reverses the survivors, or a point leaves the viewport.",
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
        "The bottom-first order of open windows. Rank 1 is the bottom. The top rank is the front.",
      term: "stack",
    },
    {
      meaning:
        "The position of one window in the stack. Zero means the window is absent.",
      term: "rank",
    },
    {
      meaning:
        "An equal left and top pixel value. The examples use 0 and 2, and one move request of 3.",
      term: "point",
    },
    {
      meaning:
        "The expanded position that a minimise stores. The value -1 means the window has no saved point.",
      term: "saved point",
    },
    {
      meaning:
        "The measured page area. The examples use 2 by 2 and 4 by 4 pixels.",
      term: "viewport",
    },
    {
      meaning:
        "The largest legal left and top value. It is viewport width minus window width. The examples use 0 and 2.",
      term: "limit",
    },
    {
      meaning:
        "One input to the pure reducer, such as open, raise, close, minimise, restore, move, or resize.",
      term: "event",
    },
    {
      meaning:
        "One observed reducer output. The model gives each distinct output a model-only id.",
      term: "state",
    },
  ],
  claim:
    "This page follows an admin window stack from no window to close and restore. Every observed event keeps a valid stack, a saved expanded position, and a point inside the limit.",
  limits: [
    "The examples use three keys, points 0 and 2, one move request of 3, sizes 2 by 2, and viewports 2 by 2 and 4 by 4. They do not prove every pixel input.",
    "Input keys and measurements are assumed. Each live window has a resize measurement, and open receives its initial positioned point.",
    "The model checks a pure reducer. It does not prove browser event delivery, pointer capture, focus, native dialog timing, CSS size, rendered content, or actual viewport measurement.",
    "The model does not check drag click suppression, one axis of a position, or an oversized window.",
    "No fairness rule is present. Safety does not prove that a window eventually closes or restores.",
  ],
  module: "ModalLifecycle",
  safety:
    "Every current state has a valid stack with unique consecutive ranks. Each live window has its requested point, clamped to the limit when the event needs a clamp. A saved point belongs to the expanded position. The initial row is empty and the retained verdict is true.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/modal-lifecycle.ts",
          symbol: "modalLifecycleFacts",
        },
        {
          path: "src/ui/client/admin/modal-state.ts",
          symbol: "transitionModals",
        },
      ],
      rules: ["Init", "Empty", "Keys", "NodeIds", "EventIds", "DomainOK"],
      title: "Start with no window",
      values: [
        { name: "windows", value: "0" },
        { name: "safe", value: "TRUE" },
        { name: "aRank", value: "0" },
        { name: "aPoint", value: "-1" },
        { name: "aSaved", value: "-1" },
        { name: "state rows", value: "71" },
        { name: "input rows", value: "12" },
        { name: "observed transitions", value: "852" },
      ],
      what: "The model starts before the first open. Empty is the row with id 0 and every rank at zero. Keys names a, b, and c. NodeIds holds every discovered state id, and EventIds holds every selected event id. DomainOK checks that row 1 is Empty, that every row id matches its tuple position, and that every state has one target for each event.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal.ts",
          symbol: "openAdminModal",
        },
        {
          path: "src/ui/client/admin/modal-state.ts",
          symbol: "transitionModals",
        },
      ],
      rules: [
        "Transition",
        "PositionEvent",
        "OrderLaw",
        "SavedLaw",
        "PointLaw",
        "ValidStack",
        "Rank",
      ],
      title: "Open a at pixel 2",
      values: [
        { name: "aRank", value: "1" },
        { name: "aPoint", value: "2" },
        { name: "aSaved", value: "-1" },
        { name: "bRank", value: "0" },
        { name: "cRank", value: "0" },
      ],
      what: "Open on an absent key appends the window at the top. The point is the positioned point that the caller supplies. The application sends the open event through openAdminModal. The pixel 2 is an assumed input for the finite domain, not a measured browser value. The saved point stays -1 because the window is expanded. Rank reads the new stack position, and ValidStack requires unique consecutive ranks.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal.ts",
          symbol: "closeAdminModal",
        },
        {
          path: "src/ui/client/admin/modal-state.ts",
          symbol: "transitionModals",
        },
      ],
      rules: [
        "Transition",
        "OrderLaw",
        "Count",
        "ValidStack",
        "Rank",
        "Snapshot",
        "SavedLaw",
      ],
      title: "Close a and keep b below c",
      values: [
        {
          name: "before close",
          value: "aRank 1, bRank 2, cRank 3, Count 3.",
        },
        {
          name: "after close",
          value: "aRank 0, bRank 1, cRank 2, Count 2.",
        },
        { name: "aPoint", value: "-1 after close" },
        { name: "aSaved", value: "-1 after close" },
      ],
      what: "Open b and open c append each window above the last. A close removes its key and shifts the later windows down by one. The survivors keep their relative order, so b stays below c. Snapshot reads the source and target rows from the observed state table. Count reads how many windows are live. A close clears the saved point.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal-state.ts",
          symbol: "transitionModals",
        },
      ],
      rules: [
        "Transition",
        "PositionEvent",
        "SavedLaw",
        "Saved",
        "Point",
        "RequestedPoint",
        "NeedsClamp",
        "Clamped",
        "PointLaw",
      ],
      title: "Minimise at 2 and restore",
      values: [
        { name: "after minimise", value: "aPoint 2, aSaved 2." },
        { name: "restore request", value: "saved point 2" },
        { name: "restore limit", value: "0" },
        { name: "restore result", value: "point 0, aSaved -1." },
      ],
      what: "The first minimise stores the expanded point 2. Restore requests the saved point 2, not the current point. The selected restore uses limit 0, so the nearest legal point is 0. The clamp law keeps the saved value as its request and the limit decides the final pixel. PositionEvent requires a saved point for a restore. Saved and Point read the stored values.",
    },
    {
      code: [
        {
          path: "src/ui/client/admin/modal-position.ts",
          symbol: "clampModalPosition",
        },
        {
          path: "src/ui/client/admin/modal-state.ts",
          symbol: "transitionModals",
        },
      ],
      rules: [
        "Transition",
        "NeedsClamp",
        "RequestedPoint",
        "Clamped",
        "PointLaw",
        "SavedLaw",
      ],
      title: "Resize and move clamp to the edge",
      values: [
        { name: "resize", value: "aPoint 2, limit 0, result 0." },
        { name: "move", value: "request 3, limit 2, result 2." },
        { name: "saved point", value: "Resize and move keep it." },
      ],
      what: "Resize measures every live window and clamps each current point. A move clamps the requested point. A request below zero lands at zero, and a request above the limit lands at the limit. The independent Clamped law checks the result. Move and resize keep the saved point. The production clamp uses the same nearest-edge rule.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/modal-lifecycle-matrix.ts",
          symbol: "modalTargets",
        },
        {
          path: "scripts/verify-models/modal-lifecycle.ts",
          symbol: "modalLifecycleModelData",
        },
      ],
      rules: [
        "Next",
        "Safety",
        "LegalTransition",
        "DomainOK",
        "PointLaw",
        "OrderLaw",
        "SavedLaw",
      ],
      title: "Every selected event fits the laws",
      values: [
        { name: "state rows", value: "71" },
        { name: "input rows", value: "12" },
        { name: "observed transitions", value: "852" },
        {
          name: "target",
          value: "One observed reducer state id for each source and event.",
        },
        { name: "safe", value: "TRUE" },
      ],
      what: "The producer runs transitionModals at every discovered state for every selected event. The matrix stores the observed target id. LegalTransition checks the stack order, the saved position, and the clamp law for each key. DomainOK checks the state and event tables. Safety checks the current id, the retained verdict, and the domain. Next permits any transition or a pause. Safety does not prove that a window eventually closes.",
    },
  ],
  title: "Keep the admin window stack in order through close and restore",
};
/* jscpd:ignore-end */
