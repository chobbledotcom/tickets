import {
  type Examples,
  type Feature,
  IdGenerator,
  type Rule,
  type Scenario,
  type Tag,
} from "@cucumber/messages";
import { invalidSpec } from "./errors.ts";
import { gherkinEnvelopes, parseGherkinSource } from "./gherkin.ts";
import type {
  SpecCase,
  SpecCatalog,
  SpecRegistry,
  SpecRule,
  SpecSource,
  SpecStory,
} from "./types.ts";

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const KNOWN_TAGS = new Set([
  "actor",
  "case",
  "edition",
  "owner",
  "risk",
  "rule",
  "story",
  "surface",
]);

interface ParsedTag {
  key: string;
  line: number;
  name: string;
  value: string;
}

interface ValidationState {
  ids: Set<string>;
  registry: SpecRegistry;
  uri: string;
}

const cleanDescription = (description: string): string =>
  description
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

const unknownTag = (
  tag: Pick<ParsedTag, "line" | "name">,
  uri: string,
): never => invalidSpec(uri, tag.line, `Unknown tag ${tag.name}`);

const parseTag = (tag: Tag, uri: string): ParsedTag => {
  const name = tag.name;
  const splitAt = name.indexOf(":");
  const key = name.slice(1, splitAt);
  if (splitAt < 2 || splitAt === name.length - 1 || !KNOWN_TAGS.has(key)) {
    return unknownTag({ line: tag.location.line, name }, uri);
  }
  return { key, line: tag.location.line, name, value: name.slice(splitAt + 1) };
};

const parseTags = (tags: readonly Tag[], uri: string): ParsedTag[] =>
  tags.map((tag) => parseTag(tag, uri));

const valuesFor = (tags: ParsedTag[], key: string): string[] =>
  tags.filter((tag) => tag.key === key).map((tag) => tag.value);

const requiredTagValues = (
  tags: ParsedTag[],
  key: string,
  uri: string,
  line: number,
  quantity: "one" | "some",
): string[] => {
  const values = valuesFor(tags, key);
  const valid = quantity === "one" ? values.length === 1 : values.length > 0;
  if (!valid) {
    const amount = quantity === "one" ? "exactly one" : "at least one";
    return invalidSpec(uri, line, `Expected ${amount} @${key}: tag`);
  }
  return values;
};

const rejectUnknownTags = (
  tags: ParsedTag[],
  uri: string,
  allowed: (tag: ParsedTag) => boolean,
): void => {
  for (const tag of tags) {
    if (!allowed(tag)) unknownTag(tag, uri);
  }
};

const ensureAllowed = (
  tags: ParsedTag[],
  allowed: readonly string[],
  field: "key" | "value",
  uri: string,
): void => {
  rejectUnknownTags(tags, uri, (tag) => allowed.includes(tag[field]));
};

const addId = (
  state: ValidationState,
  kind: "case" | "rule" | "story",
  id: string,
  line: number,
): void => {
  if (!ID_PATTERN.test(id)) {
    invalidSpec(state.uri, line, `Invalid ${kind} id ${id}`);
  }
  const tagged = `@${kind}:${id}`;
  if (state.ids.has(tagged))
    invalidSpec(state.uri, line, `Duplicate ${tagged}`);
  state.ids.add(tagged);
};

const tagsFor = (
  tags: readonly Tag[],
  allowed: string[],
  state: ValidationState,
): ParsedTag[] => {
  const parsed = parseTags(tags, state.uri);
  ensureAllowed(parsed, [...allowed, "surface"], "key", state.uri);
  ensureAllowed(
    parsed.filter((tag) => tag.key === "surface"),
    state.registry.surfaces,
    "value",
    state.uri,
  );
  return parsed;
};

const idFor = (
  tags: ParsedTag[],
  kind: "case" | "rule" | "story",
  state: ValidationState,
  line: number,
): string => {
  const id = requiredTagValues(tags, kind, state.uri, line, "one").join("");
  addId(state, kind, id, line);
  return id;
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

const placeholdersIn = (scenario: Scenario): Set<string> =>
  new Set(
    Array.from(JSON.stringify(scenario).matchAll(/<([^<>]+)>/g), (match) =>
      match[1]!.trim(),
    ),
  );

const outlineCases = (
  scenario: Scenario,
  state: ValidationState,
): SpecCase[] => {
  const cases: SpecCase[] = [];
  const placeholders = placeholdersIn(scenario);
  for (const examples of scenario.examples) {
    cases.push(
      ...casesFromExamples(examples, placeholders, scenario.name, state),
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
  state: ValidationState,
): SpecCase[] => {
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
    addId(state, "case", id, row.location.line);
    return { id, line: row.location.line, name: scenarioName };
  });
};

const scenarioCases = (
  scenario: Scenario,
  state: ValidationState,
): SpecCase[] => {
  const tags = tagsFor(scenario.tags, ["case"], state);
  if (scenario.examples.length > 0) {
    if (valuesFor(tags, "case").length > 0) {
      invalidSpec(
        state.uri,
        scenario.location.line,
        "Scenario Outline case ids belong in Examples",
      );
    }
    return outlineCases(scenario, state);
  }
  const id = idFor(tags, "case", state, scenario.location.line);
  return [{ id, line: scenario.location.line, name: scenario.name }];
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
  const oneFeatureValue = (key: string): string =>
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
  const envelopes: object[] = [];

  for (const source of sorted) {
    state.uri = source.uri;
    const document = parseGherkinSource(source, newId);
    const feature = document.feature;
    if (!feature) return invalidSpec(source.uri, 1, "Feature is required");
    stories.push(storyFromFeature(feature, state));
    envelopes.push(...gherkinEnvelopes(source, document, newId));
  }

  return {
    ndjson: `${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`,
    stories,
  };
};
