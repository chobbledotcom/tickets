import * as v from "valibot";

const RegisteredValuesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  v.minLength(1),
  v.check(
    (values) => new Set(values).size === values.length,
    "Registered values must be unique",
  ),
);

export const SpecRegistrySchema = v.strictObject({
  actors: RegisteredValuesSchema,
  editions: RegisteredValuesSchema,
  owners: RegisteredValuesSchema,
  risks: RegisteredValuesSchema,
  surfaces: RegisteredValuesSchema,
});

export type SpecRegistry = v.InferOutput<typeof SpecRegistrySchema>;

export interface SpecSource {
  data: string;
  uri: string;
}

export interface SpecItem {
  id: string;
  line: number;
  name: string;
  surfaces: string[];
}

export interface SpecRule extends SpecItem {
  cases: SpecItem[];
  description: string;
}

export interface SpecStory extends SpecItem {
  actors: string[];
  description: string;
  editions: string[];
  owner: string;
  risk: string;
  rules: SpecRule[];
  uri: string;
}

export interface SpecCatalog {
  stories: SpecStory[];
}

interface SpecCaseContext {
  rule: SpecRule;
  specCase: SpecItem;
  story: SpecStory;
}

export const specCasesWithContext = (catalog: SpecCatalog): SpecCaseContext[] =>
  catalog.stories.flatMap((story) =>
    story.rules.flatMap((rule) =>
      rule.cases.map((specCase) => ({ rule, specCase, story })),
    ),
  );
