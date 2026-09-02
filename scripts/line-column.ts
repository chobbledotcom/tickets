/** The 1-based line and column of UTF-16 offset `index` within `content`. */
export const lineColumnAt = (
  content: string,
  index: number,
): { column: number; line: number } => {
  const lines = content.slice(0, index).split("\n");
  return { column: lines.at(-1)!.length + 1, line: lines.length };
};
