import type { Tag } from "@cucumber/messages";
import * as v from "valibot";
import { invalidSpec } from "./errors.ts";
import type { SpecRegistry } from "./types.ts";

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SpecTagKeySchema = v.picklist([
  "actor",
  "case",
  "edition",
  "owner",
  "risk",
  "rule",
  "story",
  "surface",
]);
type SpecTagKey = v.InferOutput<typeof SpecTagKeySchema>;

export interface ParsedTag {
  key: SpecTagKey;
  line: number;
  name: string;
  value: string;
}

export interface ValidationState {
  ids: Set<string>;
  registry: SpecRegistry;
  uri: string;
}

const unknownTag = (
  tag: Pick<ParsedTag, "line" | "name">,
  uri: string,
): never => invalidSpec(uri, tag.line, `Unknown tag ${tag.name}`);

const parseTag = (tag: Tag, uri: string): ParsedTag => {
  const name = tag.name;
  const splitAt = name.indexOf(":");
  const key = name.slice(1, splitAt);
  if (
    splitAt < 2 ||
    splitAt === name.length - 1 ||
    !v.is(SpecTagKeySchema, key)
  ) {
    return unknownTag({ line: tag.location.line, name }, uri);
  }
  return { key, line: tag.location.line, name, value: name.slice(splitAt + 1) };
};

const parseTags = (tags: readonly Tag[], uri: string): ParsedTag[] =>
  tags.map((tag) => parseTag(tag, uri));

const rejectDuplicateTags = (tags: ParsedTag[], uri: string): void => {
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag.name)) {
      invalidSpec(uri, tag.line, `Duplicate ${tag.name}`);
    }
    seen.add(tag.name);
  }
};

export const valuesFor = (tags: ParsedTag[], key: SpecTagKey): string[] =>
  tags.filter((tag) => tag.key === key).map((tag) => tag.value);

export const requiredTagValues = (
  tags: ParsedTag[],
  key: SpecTagKey,
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

export const ensureAllowed = (
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
  if (state.ids.has(id)) invalidSpec(state.uri, line, `Duplicate ${tagged}`);
  state.ids.add(id);
};

export const tagsFor = (
  tags: readonly Tag[],
  allowed: SpecTagKey[],
  state: ValidationState,
): ParsedTag[] => {
  const parsed = parseTags(tags, state.uri);
  rejectDuplicateTags(parsed, state.uri);
  ensureAllowed(parsed, [...allowed, "surface"], "key", state.uri);
  ensureAllowed(
    parsed.filter((tag) => tag.key === "surface"),
    state.registry.surfaces,
    "value",
    state.uri,
  );
  return parsed;
};

export const idFor = (
  tags: ParsedTag[],
  kind: "case" | "rule" | "story",
  state: ValidationState,
  line: number,
): string => {
  const id = requiredTagValues(tags, kind, state.uri, line, "one").join("");
  addId(state, kind, id, line);
  return id;
};

export const addCaseId = (
  state: ValidationState,
  id: string,
  line: number,
): void => addId(state, "case", id, line);
