import type { TlaCollection } from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";

const setBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(new RegExp(`^${name} == \\{([\\s\\S]*?)\\}$`, "m")),
    `Missing checker set ${name}`,
  );
  return requireValue(match[1], `Missing checker set body ${name}`);
};
const sequenceBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(new RegExp(`^${name} == <<(.*)>>$`, "m")),
    `Missing checker sequence ${name}`,
  );
  return requireValue(match[1], `Missing checker sequence body ${name}`);
};
export const members = (data: string, name: string): string[] =>
  JSON.parse(`[${setBody(data, name)}]`);

const recordTokens: Record<string, string> = {
  "[": "{",
  "]": "}",
  FALSE: "false",
  TRUE: "true",
};

/** Both semantic sets and indexed pages name the same typed row definitions. */
const recordBodies = (data: string, body: string): string => {
  if (body.trim() === "") return "";
  return body
    .split(",")
    .map((reference) => {
      const row = reference.trim();
      const match = requireValue(
        data.match(new RegExp(`^${row} == (\\[.*\\])$`, "m")),
        `Missing checker record ${row}`,
      );
      return requireValue(match[1], `Missing checker record body ${row}`);
    })
    .join(",");
};

type DecodedRecord = Record<string, string | boolean | number>;

const decodeRecords = (bodies: string): DecodedRecord[] =>
  JSON.parse(
    `[${bodies.replaceAll(
      /"(?:\\.|[^"\\])*"|[A-Za-z_]\w*\s*\|->|\[|\]|\bTRUE\b|\bFALSE\b/g,
      (token) => {
        if (token.startsWith('"')) return token;
        if (token.endsWith("|->")) {
          return `${JSON.stringify(token.slice(0, -3).trim())}:`;
        }
        return requireValue(
          recordTokens[token],
          "The checker record token is unknown.",
        );
      },
    )}]`,
  );

/** A record set is the union of one small set for each page of rows. */
const partNames = (data: string, name: string): string[] => {
  const match = requireValue(
    data.match(new RegExp(`^${name} == (.*)$`, "m")),
    `Missing checker set ${name}`,
  );
  const whole = requireValue(match[1], `Missing checker set body ${name}`);
  return whole === "{}" ? [] : whole.split(" \\cup ");
};

export const records = (
  data: string,
  name: string,
  collection: TlaCollection = "Set",
): DecodedRecord[] =>
  collection === "Seq"
    ? decodeRecords(recordBodies(data, sequenceBody(data, name)))
    : partNames(data, name).flatMap((part) =>
        decodeRecords(recordBodies(data, setBody(data, part))),
      );

/** The row text of each page. A named operator holds one page, and the page
 *  list names those operators in order. */
const pageBodies = (data: string, name: string): string[] => {
  const list = requireValue(
    data.match(new RegExp(`^${name}Pages == <<(.*)>>$`, "m")),
    `Missing checker pages ${name}`,
  );
  const names = requireValue(list[1], `Missing checker page list ${name}`);
  if (names === "") return [];
  return names.split(", ").map((page) => {
    const match = requireValue(
      data.match(new RegExp(`^${page} == <<(.*)>>$`, "m")),
      `Missing checker page ${page}`,
    );
    return requireValue(match[1], `Missing checker page body ${page}`);
  });
};

/** Decode each physical page separately so tests can check the index bijection. */
export const recordPages = (data: string, name: string): DecodedRecord[][] =>
  pageBodies(data, name).map((page) => decodeRecords(recordBodies(data, page)));

export const memberPages = (data: string, name: string): string[][] =>
  pageBodies(data, name).map((page) => JSON.parse(`[${page}]`));
