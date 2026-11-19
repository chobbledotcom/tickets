import type { TlaRecord } from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";

const COLLECTION_FORMAT = {
  Seq: ["<<", ">>", "sequence"],
  Set: ["\\{", "\\}", "set"],
} as const;
type Collection = keyof typeof COLLECTION_FORMAT;

const collectionBody = (
  data: string,
  name: string,
  collection: Collection = "Set",
): string => {
  const [open, close, kind] = COLLECTION_FORMAT[collection];
  const match = requireValue(
    data.match(new RegExp(`${name} == ${open}([\\s\\S]*?)${close}(?=\\n|$)`)),
    `Missing checker ${kind} ${name}`,
  );
  return requireValue(match[1], `Missing checker ${kind} body ${name}`);
};
export const members = (data: string, name: string): string[] =>
  JSON.parse(`[${collectionBody(data, name)}]`);

const recordTokens: Record<string, string> = {
  "[": "{",
  "]": "}",
  FALSE: "false",
  TRUE: "true",
};

export const records = (
  data: string,
  name: string,
  collection: Collection = "Set",
): TlaRecord[] =>
  JSON.parse(
    `[${collectionBody(data, name, collection).replaceAll(
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
