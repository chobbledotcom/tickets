import { consoleOutput, reportCheck } from "#scripts/check-report.ts";
import {
  denoGuideAccess,
  type GuideAccess,
  loadSources,
  readModel,
  sourcesFor,
} from "#scripts/model-guides/access.ts";
import { GUIDES } from "#scripts/model-guides/registry.ts";
import { renderIndex, renderPage } from "#scripts/model-guides/render.ts";
import type { SourceDefinition } from "#scripts/model-guides/source.ts";
import type { ModelGuide } from "#scripts/model-guides/types.ts";
import {
  coverageIssues,
  fieldIssues,
  issue,
  type ModuleRun,
  ruleIssues,
  sourceIssues,
  stepIssues,
} from "#scripts/model-guides/validate.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";

/** The guides and the models that they must cover. */
export type GuideContext = {
  readonly guides: readonly ModelGuide[];
  readonly modules: readonly VerificationModule[];
};

export const guideContext: GuideContext = {
  guides: GUIDES,
  modules: VERIFICATION_MODULES,
};

type PreparedGuide = {
  readonly run: ModuleRun;
  readonly definitions: ReadonlyMap<string, SourceDefinition>;
  readonly findings: string[];
};

const prepareGuide = async (
  guide: ModelGuide,
  declaration: VerificationModule,
  access: GuideAccess,
): Promise<PreparedGuide> => {
  const run = await readModel(declaration, access.read);
  const loaded = await loadSources(guide, access);
  return {
    definitions: loaded.definitions,
    findings: [
      ...fieldIssues(guide),
      ...stepIssues(guide, run.declaration.kind === "model"),
      ...coverageIssues(guide, run),
      ...ruleIssues(guide, run),
      ...sourceIssues(guide, run),
      ...loaded.findings,
    ],
    run,
  };
};

const registryIssues = (context: GuideContext): string[] => {
  const findings: string[] = [];
  const modules = new Set(context.modules.map((entry) => entry.module));
  const seen = new Set<string>();
  for (const guide of context.guides) {
    if (seen.has(guide.module)) {
      findings.push(
        issue(
          `guide ${guide.module}`,
          "guide-duplicate",
          "The guide is declared more than once.",
          "Keep one walkthrough for each model.",
        ),
      );
    }
    seen.add(guide.module);
    if (modules.has(guide.module)) continue;
    findings.push(
      issue(
        `guide ${guide.module}`,
        "guide-extra",
        "The guide has no registered model.",
        "Register the model or remove the guide.",
      ),
    );
  }
  for (const entry of context.modules) {
    if (seen.has(entry.module)) continue;
    findings.push(
      issue(
        `guide ${entry.module}`,
        "guide-missing",
        "The model has no walkthrough.",
        "Add a guide under scripts/model-guides/guides/.",
      ),
    );
  }
  return findings;
};

type PreparedSet =
  | {
      readonly kind: "ok";
      readonly prepared: ReadonlyMap<string, PreparedGuide>;
    }
  | { readonly kind: "issues"; readonly findings: string[] };

const prepareSet = async (
  access: GuideAccess,
  context: GuideContext,
): Promise<PreparedSet> => {
  const declarations = new Map(
    context.modules.map((entry) => [entry.module, entry]),
  );
  const findings = registryIssues(context);
  const prepared = new Map<string, PreparedGuide>();
  for (const guide of context.guides) {
    const declaration = declarations.get(guide.module);
    if (declaration === undefined) continue;
    const result = await prepareGuide(guide, declaration, access);
    prepared.set(guide.module, result);
    findings.push(...result.findings);
  }
  return findings.length === 0
    ? { kind: "ok", prepared }
    : { findings, kind: "issues" };
};

const renderPrepared = (
  context: GuideContext,
  prepared: ReadonlyMap<string, PreparedGuide>,
): Map<string, string> => {
  const pages = new Map<string, string>();
  for (const guide of context.guides) {
    const result = prepared.get(guide.module)!;
    pages.set(
      `${guide.module}.md`,
      renderPage(guide, sourcesFor(result.run, result.definitions)),
    );
  }
  pages.set("README.md", renderIndex(context.guides));
  return pages;
};

/** Render every page. A missing rule or declaration stops the run. */
export const generateModelGuidePages = async (
  access: GuideAccess = denoGuideAccess,
  context: GuideContext = guideContext,
): Promise<Map<string, string>> => {
  const result = await prepareSet(access, context);
  if (result.kind === "issues") {
    throw new Error(result.findings.join("\n"));
  }
  return renderPrepared(context, result.prepared);
};

/** Every finding against the guide set, the models, and the sources. */
export const findModelGuideIssues = async (
  access: GuideAccess = denoGuideAccess,
  context: GuideContext = guideContext,
): Promise<string[]> => {
  const result = await prepareSet(access, context);
  return result.kind === "issues" ? result.findings : [];
};

/** Report the guide check through the standard check format. */
export const checkModelGuides = async (
  output = consoleOutput,
  access: GuideAccess = denoGuideAccess,
  context: GuideContext = guideContext,
): Promise<number> =>
  reportCheck({
    ...output,
    found: await findModelGuideIssues(access, context),
    guide: "docs/model-verification.md",
    noun: "model walkthrough",
    success:
      "Model walkthroughs: every model has a guide with mapped rules and production code.",
  });
