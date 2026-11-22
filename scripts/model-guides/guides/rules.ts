import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The shared rules that other models call. */
/* jscpd:ignore-start -- static data, not code */
export const modelRules: ModelGuide = {
  badOutcome:
    "A refused action looks accepted, a sample sits in a state the machine does not declare, or a later success hides an earlier failure.",
  cast: [
    {
      meaning:
        "One attempted change from a source state to a target state. The target can break a rule.",
      term: "attempt",
    },
    {
      meaning:
        "The label of the state before the attempt and the label after it.",
      term: "state label",
    },
    {
      meaning:
        "A result from the production code, turned into an example record.",
      term: "fact",
    },
    {
      meaning:
        "A model-only flag that remembers an earlier failed check. It is not an application status or a database field.",
      term: "remembered verdict",
    },
  ],
  claim:
    "This page explains the small rules that the other models share. Each rule turns one kind of evidence into a yes or no answer.",
  limits: [
    "The helper has no state of its own, no start state, and no step relation.",
    "It makes no claim about a business lifecycle.",
    "Each model that uses a rule supplies its own facts and its own safety claim.",
  ],
  module: "ModelRules",
  safety:
    "The helper does not claim safety by itself. It supplies the pieces that a model joins into its own safety rule.",
  steps: [
    {
      code: [],
      rules: ["RefusedActionKeepsState"],
      title: "A refusal leaves the state alone",
      values: [
        { name: "accepted", value: "FALSE" },
        { name: "sourceState", value: "pending" },
        { name: "targetState", value: "pending" },
        { name: "verdict", value: "TRUE" },
      ],
      what: "The rule reads one attempt. An accepted attempt passes without a target-state check. A refused attempt must keep the same state label. A refusal that moves the label is a bug.",
    },
    {
      code: [],
      rules: ["SampleMatchesDeclaredState"],
      title: "A sample must match its declared state",
      values: [
        { name: "declaredState", value: "ending" },
        { name: "storedState", value: "ending" },
        { name: "allowedStates", value: "{pending, ending, gone, unwritten}" },
        { name: "verdict", value: "TRUE" },
      ],
      what: "The rule compares the state that a machine declares with the state that a sample holds. A declared state that the machine does not allow returns FALSE. This stops a sample from standing for an invented state.",
    },
    {
      code: [],
      rules: ["ChecksStillPass"],
      title: "A later success cannot erase a failure",
      values: [
        { name: "previousChecksPassed", value: "TRUE" },
        { name: "currentCheckPassed", value: "FALSE" },
        { name: "next value", value: "FALSE" },
        { name: "a later check", value: "TRUE leaves the result FALSE" },
      ],
      what: "The rule joins the earlier verdict with the current verdict. Once the result is FALSE, it stays FALSE. A bad event therefore remains visible after a later good event.",
    },
    {
      code: [],
      rules: ["AttemptedEdge"],
      title: "Record the attempt and its verdict",
      values: [
        { name: "state", value: "the current state label" },
        { name: "targetState", value: "the observed result label" },
        { name: "safe", value: "the remembered verdict after the step" },
      ],
      what: "This rule moves the model to the target label and remembers the verdict. It does not refuse an unsafe move. The safety rule of the calling model must reject that move.",
    },
    {
      code: [],
      rules: ["RowIds", "RowAt", "TablesWellFormed"],
      title: "A table and its matrix must agree",
      values: [
        { name: "row id 0", value: "tuple position 1" },
        { name: "rows", value: "Every row stores its own id." },
        { name: "targets", value: "One target for each state and event." },
      ],
      what: "A model keeps its observed states in a tuple of records. RowIds names the ids of the rows, and RowAt reads one row. TablesWellFormed checks that every row stores its own id. It also checks that each state has one target for each event, and that each target is a state id.",
    },
    {
      code: [],
      rules: ["RankOf", "OpenWindows", "RanksInRange"],
      title: "A stack of three windows keeps valid ranks",
      values: [
        { name: "rank 0", value: "the window is absent" },
        { name: "rank 1", value: "the bottom window" },
        {
          name: "open windows",
          value: "The top rank is the number of windows.",
        },
      ],
      what: "A stack of windows a, b, and c stores one rank for each window. RankOf reads the rank of one window, and OpenWindows counts the windows that are open. RanksInRange requires each rank to be 0 to 3, and no rank to be above the number of open windows.",
    },
  ],
  title: "The shared rules behind every model",
};
/* jscpd:ignore-end */
