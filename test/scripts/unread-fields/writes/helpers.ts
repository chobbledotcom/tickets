/**
 * Reading a scrap of code and putting a question to one mention in it.
 * Shared by the writes suites, because every suite asks the same scraps.
 */
import ts from "typescript";
import {
  type AskAboutAMention,
  namesAMember,
  nodeAt,
  readsTheValue,
} from "#scripts/unread-fields/writes.ts";

/** Read a scrap of code as one kind of file. `<number>x` is an assertion in
 * TypeScript and a tag in TSX, so a case about it has to say which. */
const parsing =
  (kind: ts.ScriptKind, extension: string) =>
  (code: string): ts.SourceFile =>
    ts.createSourceFile(
      `probe.${extension}`,
      code,
      ts.ScriptTarget.ESNext,
      true,
      kind,
    );

export const parse = parsing(ts.ScriptKind.TSX, "tsx");
const parsePlainTs = parsing(ts.ScriptKind.TS, "ts");

/** Put a question to the mention of `field` at `nth` in a scrap of code. */
export const askAt =
  (ask: AskAboutAMention, read: (code: string) => ts.SourceFile = parse) =>
  (code: string, field: string, nth = 0): boolean => {
    const source = read(code);
    let from = -1;
    for (let seen = 0; seen <= nth; seen++) {
      from = code.indexOf(field, from + 1);
    }
    const node = nodeAt(source, from);
    if (!node) throw new Error(`no node at ${from} in ${code}`);
    return ask(node);
  };

/** Whether that mention takes the value out of the field. */
export const readsAt = askAt(readsTheValue);

/** Whether that mention names a member of something. */
export const namesAMemberAt = askAt(namesAMember);

/** The same question, put to code an angle-bracket assertion can live in. */
export const readsInPlainTsAt = askAt(readsTheValue, parsePlainTs);

export { parsePlainTs };
