import type {
  Background,
  GherkinDocument,
  Pickle,
  Scenario,
  Step,
} from "@cucumber/messages";
import type { SpecCatalog, SpecRule, SpecStory } from "#scripts/specs/types.ts";
import { requireValue } from "#shared/required-value.ts";

interface StableNamedItem {
  description: string;
  id: string;
  name: string;
}

export interface ResolvedEvidenceScenario {
  case: { id: string; name: string };
  rule: StableNamedItem;
  steps: Array<{ keyword: string; text: string }>;
  story: StableNamedItem;
}

interface AstIndex {
  lines: Map<string, number>;
  steps: Map<string, Step>;
}

const addSteps = (steps: readonly Step[], index: AstIndex): void => {
  for (const step of steps) index.steps.set(step.id, step);
};

const addBackground = (background: Background, index: AstIndex): void => {
  index.lines.set(background.id, background.location.line);
  addSteps(background.steps, index);
};

const addScenario = (scenario: Scenario, index: AstIndex): void => {
  index.lines.set(scenario.id, scenario.location.line);
  addSteps(scenario.steps, index);
  for (const examples of scenario.examples) {
    index.lines.set(examples.id, examples.location.line);
    if (examples.tableHeader) {
      index.lines.set(
        examples.tableHeader.id,
        examples.tableHeader.location.line,
      );
    }
    for (const row of examples.tableBody) {
      index.lines.set(row.id, row.location.line);
    }
  }
};

type FeatureChild = NonNullable<GherkinDocument["feature"]>["children"][number];
type StoryRule = NonNullable<FeatureChild["rule"]>;
type ScenarioChild = Pick<FeatureChild, "background" | "scenario">;

const addScenarioChild = (child: ScenarioChild, index: AstIndex): void => {
  if (child.background) addBackground(child.background, index);
  if (child.scenario) addScenario(child.scenario, index);
};

const addRule = (rule: StoryRule, index: AstIndex): void => {
  index.lines.set(rule.id, rule.location.line);
  for (const child of rule.children) addScenarioChild(child, index);
};

const addFeatureChild = (child: FeatureChild, index: AstIndex): void => {
  addScenarioChild(child, index);
  if (child.rule) addRule(child.rule, index);
};

const astIndex = (document: GherkinDocument): AstIndex => {
  const feature = document.feature;
  if (!feature) throw new Error("Evidence Gherkin document has no Feature");
  const index: AstIndex = { lines: new Map(), steps: new Map() };
  for (const child of feature.children) addFeatureChild(child, index);
  return index;
};

interface CatalogMatch {
  caseId: string;
  rule: SpecRule;
  story: SpecStory;
}

const matchesAtLines = (
  catalog: SpecCatalog,
  uri: string,
  lines: Set<number>,
): CatalogMatch[] =>
  catalog.stories.flatMap((story) =>
    story.uri === uri
      ? story.rules.flatMap((rule) =>
          rule.cases.flatMap((specCase) =>
            lines.has(specCase.line)
              ? [{ caseId: specCase.id, rule, story }]
              : [],
          ),
        )
      : [],
  );

const stableItem = (item: SpecRule | SpecStory): StableNamedItem => ({
  description: item.description,
  id: item.id,
  name: item.name,
});

const resolvedSteps = (
  pickle: Pickle,
  steps: Map<string, Step>,
): Array<{ keyword: string; text: string }> =>
  pickle.steps.map((pickleStep) => {
    const authored = pickleStep.astNodeIds
      .map((id) => steps.get(id))
      .find((step) => step !== undefined);
    if (!authored) {
      throw new Error(`Could not resolve authored step ${pickleStep.text}`);
    }
    return { keyword: authored.keyword.trim(), text: pickleStep.text };
  });

export const resolveEvidenceScenario = (
  catalog: SpecCatalog,
  document: GherkinDocument,
  pickle: Pickle,
): ResolvedEvidenceScenario => {
  const index = astIndex(document);
  const lines = new Set(
    pickle.astNodeIds
      .map((id) => index.lines.get(id))
      .filter((line): line is number => line !== undefined),
  );
  const matches = matchesAtLines(catalog, pickle.uri, lines);
  if (matches.length !== 1) {
    throw new Error(
      `Could not resolve one stable case for Cucumber Pickle ${pickle.name}`,
    );
  }
  const match = requireValue(matches[0], "Resolved evidence case is missing");
  return {
    case: { id: match.caseId, name: pickle.name },
    rule: stableItem(match.rule),
    steps: resolvedSteps(pickle, index.steps),
    story: stableItem(match.story),
  };
};
