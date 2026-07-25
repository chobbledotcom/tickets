import { dialects } from "@cucumber/gherkin";
import {
  type Examples,
  type Feature,
  IdGenerator,
  type Rule,
  type Scenario,
} from "@cucumber/messages";
import { invalidSpec } from "./errors.ts";
import { parseGherkinSource } from "./gherkin.ts";
import {
  addCaseId,
  ensureAllowed,
  idFor,
  type ParsedTag,
  requiredTagValues,
  tagsFor,
  type ValidationState,
  valuesFor,
} from "./metadata.ts";
import type {
  SpecCatalog,
  SpecItem,
  SpecRegistry,
  SpecRule,
  SpecSource,
  SpecStory,
} from "./types.ts";

const OUTLINE_KEYWORDS = new Set(
  Object.values(dialects).flatMap(({ scenarioOutline }) => scenarioOutline),
);

const cleanDescription = (description: string): string => {
  const lines = description.split("\n");
  const indentation = Math.min(
    ...lines
      .filter((line) => line.trim())
      .map((line) => line.length - line.trimStart().length),
  );
  return lines
    .map((line) => line.slice(indentation))
    .join("\n")
    .trim();
};

const requireDescription = (
  kind: "Feature" | "Rule",
  description: string,
  state: ValidationState,
  line: number,
): string => {
  const cleaned = cleanDescription(description);
  if (!cleaned) {
    invalidSpec(state.uri, line, `${kind} description is required`);
  }
  return cleaned;
};

const placeholdersIn = (scenario: Scenario): Set<string> => {
  const authoredText = [
    scenario.name,
    scenario.description,
    ...scenario.steps.flatMap((step) => [
      step.text,
      step.docString?.content ?? "",
      ...(step.dataTable?.rows.flatMap((row) =>
        row.cells.map((cell) => cell.value),
      ) ?? []),
    ]),
  ].join("\n");
  return new Set(
    Array.from(authoredText.matchAll(/<[^<>]+>/g), (match) =>
      match[0].slice(1, -1),
    ),
  );
};

const outlineCases = (
  scenario: Scenario,
  scenarioTags: ParsedTag[],
  state: ValidationState,
): SpecItem[] => {
  const cases: SpecItem[] = [];
  const placeholders = placeholdersIn(scenario);
  if (placeholders.size === 0) {
    invalidSpec(
      state.uri,
      scenario.location.line,
      "Scenario Outline needs a placeholder",
    );
  }
  for (const examples of scenario.examples) {
    cases.push(
      ...casesFromExamples(
        examples,
        placeholders,
        scenario.name,
        valuesFor(scenarioTags, "surface"),
        state,
      ),
    );
  }
  if (cases.length === 0) {
    invalidSpec(
      state.uri,
      scenario.location.line,
      "Scenario Outline needs Examples",
    );
  }
  return cases;
};

const casesFromExamples = (
  examples: Examples,
  placeholders: Set<string>,
  scenarioName: string,
  scenarioSurfaces: string[],
  state: ValidationState,
): SpecItem[] => {
  const tags = tagsFor(examples.tags, [], state);
  const surfaces = [
    ...new Set([...scenarioSurfaces, ...valuesFor(tags, "surface")]),
  ];
  const header = examples.tableHeader;
  if (!header) {
    return invalidSpec(
      state.uri,
      examples.location.line,
      "Examples need a header",
    );
  }
  const names = header.cells.map((cell) => cell.value);
  if (new Set(names).size !== names.length) {
    invalidSpec(
      state.uri,
      header.location.line,
      "Examples headers must be unique",
    );
  }
  const caseIndex = names.indexOf("case_id");
  if (caseIndex < 0) {
    invalidSpec(
      state.uri,
      header.location.line,
      "Examples need a case_id column",
    );
  }
  for (const placeholder of placeholders) {
    if (!names.includes(placeholder)) {
      invalidSpec(
        state.uri,
        examples.location.line,
        `No Examples column for placeholder <${placeholder}>`,
      );
    }
  }
  for (const name of names) {
    if (name !== "case_id" && !placeholders.has(name)) {
      invalidSpec(
        state.uri,
        header.location.line,
        `Unused Examples column ${name}`,
      );
    }
  }
  return examples.tableBody.map((row) => {
    const id = row.cells.reduce(
      (value, cell, index) => (index === caseIndex ? cell.value.trim() : value),
      "",
    );
    if (!id) {
      invalidSpec(state.uri, row.location.line, "Examples case_id is required");
    }
    addCaseId(state, id, row.location.line);
    return { id, line: row.location.line, name: scenarioName, surfaces };
  });
};

const scenarioCases = (
  scenario: Scenario,
  state: ValidationState,
): SpecItem[] => {
  const tags = tagsFor(scenario.tags, ["case"], state);
  if (scenario.steps.length === 0) {
    invalidSpec(state.uri, scenario.location.line, "Scenario needs a step");
  }
  if (OUTLINE_KEYWORDS.has(scenario.keyword)) {
    if (valuesFor(tags, "case").length > 0) {
      invalidSpec(
        state.uri,
        scenario.location.line,
        "Scenario Outline case ids belong in Examples",
      );
    }
    return outlineCases(scenario, tags, state);
  }
  if (scenario.examples.length > 0) {
    invalidSpec(
      state.uri,
      scenario.location.line,
      "Scenario cannot have Examples",
    );
  }
  const id = idFor(tags, "case", state, scenario.location.line);
  return [
    {
      id,
      line: scenario.location.line,
      name: scenario.name,
      surfaces: valuesFor(tags, "surface"),
    },
  ];
};

const storyRule = (rule: Rule, state: ValidationState): SpecRule => {
  const tags = tagsFor(rule.tags, ["rule"], state);
  const id = idFor(tags, "rule", state, rule.location.line);
  const cases = rule.children.flatMap((child) =>
    child.scenario ? scenarioCases(child.scenario, state) : [],
  );
  if (cases.length === 0) {
    invalidSpec(
      state.uri,
      rule.location.line,
      "Rule needs an executable Scenario",
    );
  }
  return {
    cases,
    description: requireDescription(
      "Rule",
      rule.description,
      state,
      rule.location.line,
    ),
    id,
    line: rule.location.line,
    name: rule.name,
    surfaces: valuesFor(tags, "surface"),
  };
};

const storyFromFeature = (
  feature: Feature,
  state: ValidationState,
): SpecStory => {
  const tags = tagsFor(
    feature.tags,
    ["actor", "edition", "owner", "risk", "story"],
    state,
  );
  const registeredValues: [string, readonly string[]][] = [
    ["actor", state.registry.actors],
    ["edition", state.registry.editions],
    ["owner", state.registry.owners],
    ["risk", state.registry.risks],
  ];
  for (const [key, allowed] of registeredValues) {
    ensureAllowed(
      tags.filter((tag) => tag.key === key),
      allowed,
      "value",
      state.uri,
    );
  }

  const id = idFor(tags, "story", state, feature.location.line);
  for (const child of feature.children) {
    if (child.scenario) {
      invalidSpec(
        state.uri,
        child.scenario.location.line,
        "Every Scenario must belong to a Rule",
      );
    }
  }
  const rules = feature.children.flatMap((child) =>
    child.rule ? [storyRule(child.rule, state)] : [],
  );
  if (rules.length === 0) {
    invalidSpec(state.uri, feature.location.line, "Feature needs a Rule");
  }
  const oneFeatureValue = (key: "owner" | "risk"): string =>
    requiredTagValues(tags, key, state.uri, feature.location.line, "one").join(
      "",
    );
  return {
    actors: requiredTagValues(
      tags,
      "actor",
      state.uri,
      feature.location.line,
      "some",
    ),
    description: requireDescription(
      "Feature",
      feature.description,
      state,
      feature.location.line,
    ),
    editions: requiredTagValues(
      tags,
      "edition",
      state.uri,
      feature.location.line,
      "some",
    ),
    id,
    line: feature.location.line,
    name: feature.name,
    owner: oneFeatureValue("owner"),
    risk: oneFeatureValue("risk"),
    rules,
    surfaces: valuesFor(tags, "surface"),
    uri: state.uri,
  };
};

export const validateSpecSources = (
  sources: SpecSource[],
  registry: SpecRegistry,
): SpecCatalog => {
  const sorted = [...sources].sort((a, b) => a.uri.localeCompare(b.uri));
  const newId = IdGenerator.incrementing();
  const state = { ids: new Set<string>(), registry, uri: "" };
  const stories: SpecStory[] = [];

  for (const source of sorted) {
    state.uri = source.uri;
    const document = parseGherkinSource(source, newId);
    const feature = document.feature;
    if (!feature) return invalidSpec(source.uri, 1, "Feature is required");
    stories.push(storyFromFeature(feature, state));
  }

  return { stories };
};
