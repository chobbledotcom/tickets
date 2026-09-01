/**
 * The runs a hand-written text scanner skips whole: quotes, templates, and
 * comments. Walking these one step at a time is the part every such scanner
 * shares, so the shape check and the import check read them from here.
 */

/** Reads a text run from where it opens, and says where it ends. */
export type RunReader = (text: string, start: number) => number;

/** Whether a comment opens at `index`. Neither `//` nor a block comment can
 * open a valid pattern, so this is the first question every reader of a `/`
 * asks. */
export const opensComment = (text: string, index: number): boolean =>
  text[index] === "/" && /[/*]/.test(text[index + 1] ?? "");

/** Just past where a quoted run closes, given the quote that opened it.
 * Escapes are skipped whole, so a quote inside the text does not close it
 * early. */
export const endOfQuoted = (
  text: string,
  start: number,
  quote: string,
): number => {
  let index = start;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
};

/** The end of the quoted run that opens at `index`, or nothing when the
 * character there opens no quoted run. */
export const endOfQuotedAt = (text: string, index: number): number | null => {
  const character = text[index] as string;
  if (character !== '"' && character !== "'") return null;
  return endOfQuoted(text, index + 1, character);
};

/**
 * Just past the character that closes a run. `step` reads one character and
 * says where to carry on from, or `null` to say that this one closes the run.
 * An escape is always skipped whole, whatever the run is.
 */
export const endOfRun = (
  text: string,
  start: number,
  step: (index: number) => number | null,
): number => {
  let index = start;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    const next = step(index);
    if (next === null) return index + 1;
    index = next;
  }
  return index;
};

/** Where a comment ends. A line comment runs to the newline, a block comment
 * to its closing pair, and one that never closes runs to the end of the
 * text. */
export const endOfComment = (text: string, start: number): number => {
  if (text[start + 1] === "/") {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
};

/** Whether a `${…}` group opens at `index`. */
const opensTemplateGroup = (text: string, index: number): boolean =>
  text[index] === "$" && text[index + 1] === "{";

/** How one character inside a brace group reads: where the run it opens ends,
 * or nothing for plain code, and what the next character sees as context —
 * the tokenizer's slash decisions are the only reader that consults it. */
export interface GroupRead {
  before: string | undefined;
  end: number | null;
}

/**
 * Just past the `}` that closes the group that opens before `start`. Braces
 * nest, so only the one that brings the depth back to nothing ends it.
 */
export const endOfBraceGroup = (
  text: string,
  start: number,
  read: (index: number, before: string | undefined) => GroupRead,
): number => {
  let depth = 1;
  let before: string | undefined;
  return endOfRun(text, start, (index) => {
    const reading = read(index, before);
    if (reading.end !== null) {
      before = reading.before;
      return reading.end;
    }
    const character = text[index] as string;
    if (character === "{") depth++;
    if (character === "}") depth--;
    before = reading.before;
    return depth === 0 ? null : index + 1;
  });
};

/**
 * Just past where the run that opens at `index` ends — a quoted string, a
 * template, or a comment — or nothing when the character is plain code. The
 * template is the caller's: the tokenizer's crosses interpolations with the
 * slash decisions it needs, the import reader's counts plain braces.
 */
export const endOfRunAt = (
  text: string,
  index: number,
  template: RunReader,
): number | null => {
  const quoted = endOfQuotedAt(text, index);
  if (quoted !== null) return quoted;
  const character = text[index] as string;
  if (character === "`") return template(text, index + 1);
  if (opensComment(text, index)) return endOfComment(text, index);
  return null;
};

/**
 * Ends a template's run: walk to the closing backtick, crossing each `${…}`
 * group whole by the reader given — the tokenizer's group reader carries the
 * slash decisions, the import reader's counts plain braces. A nested template
 * inside a group ends with its holder, whichever reader crosses it, so a
 * backtick there ends nothing. Quotes in the template's own text are text:
 * they need no pair the way `it's` needs none.
 */
export const templateEndingAt =
  (group: RunReader): RunReader =>
  (text, start) =>
    endOfRun(text, start, (index) => {
      if (text[index] === "`") return null;
      return opensTemplateGroup(text, index)
        ? group(text, index + 2)
        : index + 1;
    });

/** Just past the `}` that closes the `${` group that opens before `start`,
 * counted over plain braces. */
const endOfTemplateGroup: RunReader = (text, start) =>
  endOfBraceGroup(text, start, (index) => ({
    before: undefined,
    end: endOfRunAt(text, index, templateEndingAt(endOfTemplateGroup)),
  }));

/** The import reader's template ender, over plain-brace groups. */
export const endOfTemplateRun: RunReader = templateEndingAt(endOfTemplateGroup);

/** The text with every run the reader names replaced by what the reader says
 *  about it, the rest kept as written: the walk every character scanner in
 *  the checks reads from. */
export const mapRuns = (
  text: string,
  runAt: (index: number) => { as: string; next: number } | null,
): string => {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const run = runAt(index);
    if (run === null) {
      out += text[index];
      index++;
      continue;
    }
    out += run.as;
    index = run.next;
  }
  return out;
};

/** The text with every template run replaced by what the reader says: the
 *  walk a character scanner needs when it must hold template runs whole. */
export const mapTemplates = (
  text: string,
  ofTemplate: (run: string) => string,
): string =>
  mapRuns(text, (index) => {
    if (text[index] !== "`") return null;
    const end = endOfTemplateRun(text, index + 1);
    return { as: ofTemplate(text.slice(index, end)), next: end };
  });
