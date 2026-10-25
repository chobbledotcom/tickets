import { requireValue } from "#shared/required-value.ts";

const setBody = (data: string, name: string): string => {
  const match = data.match(new RegExp(`${name} == \\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Missing checker set ${name}`);
  return requireValue(match[1], `Missing checker set body ${name}`);
};
export const members = (data: string, name: string): string[] =>
  JSON.parse(`[${setBody(data, name)}]`);
export const tuples = (data: string, name: string): unknown[][] =>
  Array.from(setBody(data, name).matchAll(/<<([\s\S]*?)>>/g), (match) =>
    JSON.parse(
      `[${requireValue(match[1], "Missing checker tuple").replaceAll("TRUE", "true").replaceAll("FALSE", "false")}]`,
    ),
  );
