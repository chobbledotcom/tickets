import { parse } from "@cucumber/tag-expressions";
import type { SpecCatalog, SpecItem, SpecStory } from "./types.ts";

const itemTags = (kind: "case" | "rule", item: SpecItem): string[] => [
  `@${kind}:${item.id}`,
  ...item.surfaces.map((surface) => `@surface:${surface}`),
];

const storyTags = (story: SpecStory): string[] => [
  `@story:${story.id}`,
  `@owner:${story.owner}`,
  `@risk:${story.risk}`,
  ...story.actors.map((actor) => `@actor:${actor}`),
  ...story.editions.map((edition) => `@edition:${edition}`),
  ...story.surfaces.map((surface) => `@surface:${surface}`),
];

export const selectSpecCases = (
  catalog: SpecCatalog,
  tagExpression: string,
): string[] => {
  const expression = parse(tagExpression);
  return catalog.stories.flatMap((story) =>
    story.rules.flatMap((rule) => {
      const inheritedTags = [...storyTags(story), ...itemTags("rule", rule)];
      return rule.cases
        .filter((specCase) =>
          expression.evaluate([
            ...inheritedTags,
            ...itemTags("case", specCase),
          ]),
        )
        .map((specCase) => `${story.uri}:${specCase.line}`);
    }),
  );
};
