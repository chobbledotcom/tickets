export type TlaAtom = string | boolean;

export type ModelDataSource = () => Promise<string>;

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
