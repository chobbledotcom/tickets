/** One production declaration that supplies or writes the facts of a step. */
export type CodeAnchor = {
  /** Repository path, such as `src/shared/payment/claim.ts`. */
  readonly path: string;
  /** Exported name in that file. */
  readonly symbol: string;
  /** `signature` clips a long body. `declaration` shows all of it. */
  readonly detail?: "signature" | "declaration";
};

/** One named value that the reader can follow through a step. */
export type GuideValue = {
  readonly name: string;
  readonly value: string;
};

/** One event in the everyday story of a model. */
export type GuideStep = {
  /** Short heading in plain words. */
  readonly title: string;
  /** What happens at this step and why it matters. */
  readonly what: string;
  /** Example values before or after the step. */
  readonly values?: readonly GuideValue[];
  /** Top-level rules in the model that decide this step. */
  readonly rules: readonly string[];
  /** Production code behind the rules. */
  readonly code: readonly CodeAnchor[];
};

/** A walkthrough of one maintained model. */
export type ModelGuide = {
  readonly module: string;
  /** One line that names the real operation and its promise. */
  readonly title: string;
  /** What the model protects, in everyday words. */
  readonly claim: string;
  /** The concrete failure that the rules refuse. */
  readonly badOutcome: string;
  /** The safety rule in one sentence. */
  readonly safety: string;
  /** The words that the walkthrough uses. */
  readonly cast: readonly {
    readonly term: string;
    readonly meaning: string;
  }[];
  /** The ordered story. Every top-level rule must appear here. */
  readonly steps: readonly GuideStep[];
  /** What the model does not prove. */
  readonly limits: readonly string[];
};
