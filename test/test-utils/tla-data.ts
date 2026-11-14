import { requireValue } from "#shared/required-value.ts";

const setBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(new RegExp(`^${name} == \\{([\\s\\S]*?)\\}$`, "m")),
    `Missing checker set ${name}`,
  );
  return requireValue(match[1], `Missing checker set body ${name}`);
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

export const records = (data: string, name: string): DecodedRecord[] =>
  decodeRecords(recordBodies(data, setBody(data, name)));

const pageBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(new RegExp(`^${name}Pages == <<([\\s\\S]*?)>>(?=\\n|$)`, "m")),
    `Missing checker pages ${name}`,
  );
  return requireValue(match[1], `Missing checker page body ${name}`);
};

/** Decode each physical page separately so tests can check the index bijection. */
export const recordPages = (data: string, name: string): DecodedRecord[][] =>
  [...pageBody(data, name).matchAll(/<<([^<>]*)>>/g)].map((page) =>
    decodeRecords(
      recordBodies(data, requireValue(page[1], "Missing page rows")),
    ),
  );

export const memberPages = (data: string, name: string): string[][] =>
  JSON.parse(
    `[${pageBody(data, name).replaceAll(/"(?:\\.|[^"\\])*"|<<|>>/g, (token) =>
      token === "<<" ? "[" : token === ">>" ? "]" : token,
    )}]`,
  );
