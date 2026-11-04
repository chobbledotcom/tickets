import { basename, relative, resolve } from "node:path";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { readTlaSource } from "#scripts/tla/source.ts";
import { CHECK_PHASES } from "#scripts/verify-models/check.ts";
import {
  isReviewSourcePath,
  PROOF_PHASES,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";

const issue = (
  rule: string,
  problem: string,
  fix: string,
  line = 1,
): PerFileFinding => ({ fix, line, problem, rule });

const contextIssues = (declaration: VerificationModule): PerFileFinding[] => {
  const findings: PerFileFinding[] = [];
  const paths = new Set<string>();
  for (const path of declaration.context) {
    if (!isReviewSourcePath(path)) {
      findings.push(
        issue(
          "review-context",
          `${declaration.module} has a forbidden context path: ${path}.`,
          "Declare a canonical repository source path.",
        ),
      );
    }
    if (paths.has(path)) {
      findings.push(
        issue(
          "duplicate-context",
          `${declaration.module} repeats context path ${path}.`,
          "Declare each context path once.",
        ),
      );
    }
    paths.add(path);
  }
  return findings;
};

const controlIssues = (declaration: VerificationModule): PerFileFinding[] => {
  if (declaration.kind === "helper") return [];
  const findings: PerFileFinding[] = [];
  if (declaration.controls.length === 0) {
    findings.push(
      issue(
        "missing-control",
        `${declaration.module} has no negative control.`,
        "Declare a corruption that produces a real counterexample.",
      ),
    );
  }
  const names = new Set<string>();
  for (const control of declaration.controls) {
    if (control.name.trim() === "" || names.has(control.name)) {
      findings.push(
        issue(
          "control-name",
          `${declaration.module} has an empty or repeated control name.`,
          "Give each control a distinct failure name.",
        ),
      );
    }
    if (!Object.hasOwn(CHECK_PHASES, control.phase)) {
      findings.push(
        issue(
          "control-phase",
          `${declaration.module} has an invalid control phase.`,
          `Use ${PROOF_PHASES.join(" or ")}.`,
        ),
      );
    }
    names.add(control.name);
  }
  return findings;
};

const declarationIssues = (
  declaration: VerificationModule,
): PerFileFinding[] => {
  const findings = [
    ...contextIssues(declaration),
    ...controlIssues(declaration),
  ];
  if (!/^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(declaration.module)) {
    findings.push(
      issue(
        "module-name",
        `Invalid module name: ${declaration.module}.`,
        "Use a TLA module identifier.",
      ),
    );
  }
  return findings;
};

/** Check declared inputs before a checker or a review can trust the inventory. */
export const findRegistryIssues = (
  declarations: readonly VerificationModule[],
  files: readonly string[],
): PerFileFinding[] => {
  const findings: PerFileFinding[] = [];
  const declared = new Set<string>();
  const selected = new Set(
    files.map((file) => relative(Deno.cwd(), resolve(file))),
  );
  for (const declaration of declarations) {
    const name = declaration.module;
    findings.push(...declarationIssues(declaration));
    if (declared.has(name)) {
      findings.push(
        issue(
          "duplicate-module",
          `Module ${name} is declared twice.`,
          "Keep one declaration per module.",
        ),
      );
    }
    declared.add(name);
    if (!selected.has(`verification/${name}.tla`)) {
      findings.push(
        issue(
          "missing-module",
          `Module ${name} has no source file.`,
          "Add its maintained source or remove the declaration.",
        ),
      );
    }
  }
  for (const file of selected) {
    const name = basename(file, ".tla");
    if (!declared.has(name) || file !== `verification/${name}.tla`) {
      findings.push(
        issue(
          "unregistered-module",
          `${file} has no declaration.`,
          "Declare the maintained module as a model or helper.",
        ),
      );
    }
  }
  return findings;
};

/** Judge identity and helper escapes, not mathematical strength. */
export const findModuleIssues = (
  file: string,
  content: string,
  declaration: VerificationModule,
): PerFileFinding[] => {
  const source = readTlaSource(file, content);
  const findings = declarationIssues(declaration);
  if (
    source.moduleName !== declaration.module ||
    basename(file, ".tla") !== source.moduleName
  ) {
    findings.push(
      issue(
        "module-identity",
        `The header does not name ${declaration.module}.`,
        "Match the source file and declared module names.",
        source.moduleLine,
      ),
    );
  }
  if (declaration.kind === "helper") {
    const state = source.tokens.find(
      (token) =>
        token.kind === "identifier" &&
        (token.text === "VARIABLE" || token.text === "VARIABLES"),
    );
    if (state !== undefined) {
      findings.push(
        issue(
          "stateful-helper",
          "A helper declares state variables.",
          "Register this module as a model with checks and controls.",
          state.start.line,
        ),
      );
    }
  }
  for (const comment of source.comments) {
    if (/jscpd\s*:\s*ignore/i.test(comment.text)) {
      findings.push(
        issue(
          "clone-ignore",
          "A TLA comment requests a clone exclusion.",
          "Extract a shared rule instead of an exclusion.",
          comment.line,
        ),
      );
    }
  }
  return findings;
};
