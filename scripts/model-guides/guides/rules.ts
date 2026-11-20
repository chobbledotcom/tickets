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
    "This page explains four small rules that the other models share. Each rule turns one kind of evidence into a yes or no answer.",
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
  ],
  title: "The shared rules behind every model",
};
/* jscpd:ignore-end */
