import {
  type TlaComment,
  type TlaToken,
  tokenizeTla,
} from "#scripts/tla-cpd/lex.ts";

export type TlaSource = {
  readonly moduleName: string;
  readonly moduleLine: number;
  readonly tokens: readonly TlaToken[];
  readonly comments: readonly TlaComment[];
};

const matchesMarker = (token: TlaToken | undefined, marker: RegExp): boolean =>
  token !== undefined && marker.test(token.text);

/** Read lexical evidence, not the full TLA grammar. Apalache checks the grammar. */
export const readTlaSource = (file: string, content: string): TlaSource => {
  const comments: TlaComment[] = [];
  const tokens = tokenizeTla(content, file, (comment) =>
    comments.push(comment),
  );
  const [start, keyword, name, end] = tokens;
  if (
    !matchesMarker(start, /^-{4,}$/) ||
    keyword?.text !== "MODULE" ||
    name?.kind !== "identifier" ||
    !matchesMarker(end, /^-{4,}$/) ||
    !matchesMarker(tokens.at(-1), /^={4,}$/)
  ) {
    throw new Error(`${file}: The TLA module header or end marker is invalid.`);
  }
  return {
    comments,
    moduleLine: name.start.line,
    moduleName: name.text,
    tokens,
  };
};
