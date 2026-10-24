type TlaAtom = string | boolean;

const atom = (value: TlaAtom): string =>
  typeof value === "boolean"
    ? value
      ? "TRUE"
      : "FALSE"
    : JSON.stringify(value);

export const tlaSet = (values: readonly string[]): string =>
  `{${values.map(atom).join(", ")}}`;

export const tlaTuples = (rows: readonly (readonly TlaAtom[])[]): string =>
  `{\n${rows.map((row) => `  <<${row.map(atom).join(", ")}>>`).join(",\n")}\n}`;

export const tlaModule = (
  name: string,
  definitions: readonly string[],
): string => `---- MODULE ${name} ----\n${definitions.join("\n")}\n====\n`;
