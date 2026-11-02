import { requireValue } from "#shared/required-value.ts";

/** The row text of one Quint record set, without its type or wrapper. */
const setBody = (data: string, name: string): string => {
  const match = requireValue(
    data.match(
      new RegExp(
        `pure val ${name}: Set\\[\\w+\\] = Set\\(\\n([\\s\\S]*?)\\n\\)`,
      ),
    ),
    `Missing Quint set ${name}`,
  );
  return requireValue(match[1], `Missing Quint set body ${name}`);
};

/** Read the rows a Quint fact module declares. A Quint record is JSON with
 *  bare field names, so one key quote makes the set body valid JSON. */
export const quintRecords = (
  data: string,
  name: string,
): Record<string, string | boolean | number>[] =>
  JSON.parse(
    `[${setBody(data, name).replaceAll(
      /([{,]\s*)([A-Za-z_]\w*)\s*:/g,
      '$1"$2":',
    )}]`,
  );
