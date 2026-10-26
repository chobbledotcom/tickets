import { requireValue } from "#shared/required-value.ts";

const setBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(new RegExp(`${name} == \\{([\\s\\S]*?)\\}(?=\\n|$)`)),
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

export const records = (
  data: string,
  name: string,
): Record<string, string | boolean>[] =>
  JSON.parse(
    `[${setBody(data, name).replaceAll(
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
