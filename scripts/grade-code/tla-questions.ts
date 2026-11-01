/** Advisory review of supplied TLA and explicitly declared source context. */
import { asCheckEntry, type CheckEntry } from "./checks.ts";
import type { JevQuestion } from "./questions.ts";

export interface TlaCheck extends Omit<CheckEntry, "fn" | "requires"> {
  modelOnly?: true;
}

interface TlaQuestion extends Omit<JevQuestion, "requires"> {
  modelOnly?: true;
}

const questions: TlaQuestion[] = [
  {
    criteria: [
      "The abstraction contradicts supplied production evidence or invents observed facts",
      "Important observations, expectations or assumptions are conflated or unsupported",
      "The abstraction and source provenance are mostly explicit, with stated evidence gaps",
      "Each material fact has a clear source boundary; observations, independent expectations and assumptions are distinguished",
    ],
    id: "tla_abstraction_provenance",
    instructions:
      "Use the path/line-labelled sources, not inferred execution. For a model, review what abstract state means, which production decisions the generator observes, and what it assumes or omits. For a helper, review the law's parameters, meaning and caller boundary. A metadata declaration is not evidence of fidelity. Source alone cannot establish runtime observations or production refinement: identify unestablished provenance and judge honest limits rather than inventing execution.",
    label: "Abstraction and production provenance",
    weight: 5,
  },
  {
    criteria: [
      "Safety is vacuous, contradictory or excludes a concrete violation visible in the sources",
      "Material laws, domain signs or reachable cases are unaccounted for",
      "Useful invariants and domains cover the main claim, with explicit bounded gaps",
      "Initial and step obligations, meaningful states, domain signs and non-vacuity are all well justified by the supplied evidence",
    ],
    id: "tla_invariant_strength",
    instructions:
      "Inspect Init, Next and Safety and declared generator source. Is Safety strong enough for the stated claim, including non-negative amounts and valid identity/domain constraints? Could a false antecedent, empty domain, over-restricted induction start or tautology make it vacuous? Distinguish finite representative values from universal arithmetic. Do not claim that token extraction validates full syntax, that an invariant holds, or that a checker ran. Identify unsupported obligations as evidence gaps.",
    label: "Invariant strength and non-vacuity",
    modelOnly: true,
    weight: 5,
  },
  {
    criteria: [
      "Lost identity permits a visible wrong assignment to satisfy the stated law",
      "Totals or sets obscure important item, group or operation attribution",
      "Relevant identity is mostly retained and losses are bounded explicitly",
      "The abstraction preserves the identity and scope needed by each claimed law, or clearly explains why aggregation is sufficient",
    ],
    id: "tla_identity",
    instructions:
      "Review whether sums, sets, sorted values or Boolean projections lose per-item, attendee, group/date, account, request or operation identity needed by the claim. For helpers inspect parameter identities and caller expectations, not nonexistent state variables. Conservation alone does not establish correct attribution. Ground findings in supplied source lines; do not invent a production caller when none is supplied.",
    label: "Identity and attribution survive abstraction",
    weight: 4,
  },
  {
    criteria: [
      "Expected results repeat the same faulty business calculation or omit a visible essential arithmetic law",
      "Oracle independence, rounding or allocation boundaries lack meaningful support",
      "Arithmetic expectations are mostly independent and the remaining limits are explicit",
      "Business arithmetic has a separately justified oracle and covers relevant signs, rounding, fees, tax and attribution; non-arithmetic modules do not invent arithmetic claims",
    ],
    id: "tla_independent_arithmetic",
    instructions:
      "Where arithmetic appears, compare producer observations, expectations and helper laws. Calling the production allocator twice, copying its calculation into an oracle, or sharing the same business rule does not provide independence. Consider negative and zero values, boundaries, rounding, fee/tax bases and per-item allocation. Sharing generic record rendering or proof plumbing is not itself a faulty shared oracle. For modules without business arithmetic, assess the actual shared laws without requiring irrelevant money checks. Source review cannot prove unbounded completeness or detect every semantic duplicate.",
    label: "Independent arithmetic and shared laws",
    weight: 4,
  },
  {
    criteria: [
      "The supplied controls cannot challenge the claimed law or deliberately treat checker errors as counterexamples",
      "Only post-generation fact corruption is visible, or producer faults and excluded domains are unexplained",
      "Relevant controls challenge the model, with producer-level and execution-evidence limits stated",
      "Controls independently challenge producer decisions and model laws, including initial-domain corruption where relevant, without conflating errors with counterexamples",
    ],
    id: "tla_producer_controls",
    instructions:
      "Review declared control names/phases and supplied producer source. Distinguish model-level corruption from fault injection at the production decision/fact producer: the former cannot establish producer fidelity. Ask whether faults survive projection, remain in the initial/step domain and exercise the intended invariant. A control must produce a violated invariant with a trace in a real run; no such execution is supplied here, so never assert it ran or passed. Do not infer controls from names alone or require helper modules to have controls.",
    label: "Producer-level controls challenge the claim",
    modelOnly: true,
    weight: 4,
  },
  {
    criteria: [
      "The source claims production or liveness guarantees not supported by the abstract safety model",
      "Material bounds, write/crash/race gaps or fairness assumptions are hidden",
      "The main safety boundary and remaining production obligations are clear",
      "Bounds, safety versus liveness, fairness, writes, rollback, crash windows and cross-model obligations are explicit wherever relevant",
    ],
    id: "tla_limits",
    instructions:
      "Assess the actual claim against supplied evidence. A safety invariant is not eventual progress; liveness requires appropriate temporal/fairness reasoning. A decision projection is not a durable SQL write or race/crash proof. Helpers provide only their declared laws, not whole-system safety. Look for representative domain limits, concurrency/rollback gaps and cross-model obligations relevant to this module. JEV is advisory source review, not an Apalache run, proof of production refinement, full TLA syntax validation or semantic clone detector.",
    label: "Honest limits, safety and liveness",
    weight: 4,
  },
  {
    criteria: [
      "Opaque or misleading definitions conceal an incorrect shared law",
      "Names, assumptions or parameter domains make correct use difficult",
      "Definitions communicate their laws and most required assumptions",
      "Definitions are readable, narrowly scoped and make parameter domains and non-obvious assumptions clear without duplicating business oracles",
    ],
    id: "tla_shared_laws",
    instructions:
      "Review operator names, parameter domains, comments and reuse against the selected module's role and declared source context. A helper need not define Init, Next or Safety. Review its actual reusable laws and meaningful edge cases instead. Comments should explain constraints, not assert proof success. Do not demand one formula shape, one comment phrase, unused imports or a preferred Next suffix. Token similarity cannot establish semantic independence.",
    label: "Readable and correctly scoped shared laws",
    weight: 3,
  },
];

export const TLA_QUESTIONS: TlaCheck[] = questions.map(
  (question): TlaCheck => ({
    ...asCheckEntry(question),
    ...(question.modelOnly ? { modelOnly: true } : {}),
  }),
);
