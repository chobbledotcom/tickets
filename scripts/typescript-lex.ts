const isQuote = (char: string | undefined): boolean =>
  char === '"' || char === "'" || char === "`";

type ScanStep = number | "end" | null;

/** Walk text until a caller finds its end, skipping nested quoted text. */
const scanText = (
  content: string,
  start: number,
  next: (char: string | undefined, index: number) => ScanStep,
): number => {
  let index = start;
  while (index < content.length) {
    const step = next(content[index], index);
    if (step === "end") return index + 1;
    if (step !== null) {
      index = step;
      continue;
    }
    index = isQuote(content[index]) ? skipString(content, index) : index + 1;
  }
  return index;
};

/** Skip one template substitution, including nested braces and strings. */
const skipTemplateSubstitution = (content: string, start: number): number => {
  let depth = 1;
  return scanText(content, start + 2, (char, index) => {
    if (char === "{") {
      depth += 1;
      return index + 1;
    }
    if (char !== "}") return null;
    depth -= 1;
    return depth === 0 ? "end" : index + 1;
  });
};

/** Skip a string or template literal and return the index after its end. */
export const skipString = (content: string, start: number): number => {
  const quote = content[start];
  return scanText(content, start + 1, (char, index) => {
    if (char === "\\") return index + 2;
    if (char === quote) return "end";
    if (quote === "`" && char === "$" && content[index + 1] === "{") {
      return skipTemplateSubstitution(content, index);
    }
    return index + 1;
  });
};

/** Skip a comment at `start`, or return `start` when there is no comment. */
export const skipComment = (content: string, start: number): number => {
  if (content[start] === "/" && content[start + 1] === "/") {
    let index = start;
    while (index < content.length && content[index] !== "\n") index += 1;
    return index;
  }
  if (content[start] === "/" && content[start + 1] === "*") {
    let index = start + 2;
    while (
      index < content.length &&
      !(content[index] === "*" && content[index + 1] === "/")
    ) {
      index += 1;
    }
    return Math.min(index + 2, content.length);
  }
  return start;
};

/** Skip lexical text at `start`, or return `start` for executable code. */
export const skipCommentOrString = (content: string, start: number): number => {
  const pastComment = skipComment(content, start);
  if (pastComment !== start) return pastComment;
  return isQuote(content[start]) ? skipString(content, start) : start;
};

/** Replace comments and optionally strings with spaces while keeping offsets. */
export const blankSpans = (content: string, blankStrings: boolean): string => {
  const output = content.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (output[index] !== "\n") output[index] = " ";
    }
  };
  let index = 0;
  while (index < content.length) {
    const pastComment = skipComment(content, index);
    if (pastComment !== index) {
      blank(index, pastComment);
      index = pastComment;
      continue;
    }
    if (isQuote(content[index])) {
      const end = skipString(content, index);
      if (blankStrings) blank(index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return output.join("");
};
