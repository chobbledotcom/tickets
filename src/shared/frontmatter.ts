// effects: pure
/** The frontmatter block and the body of one markdown file.
 *
 *  Both readers share one normalisation: Windows line endings read like Unix
 *  ones, so a file edited on any machine parses the same way. */

export type MarkdownFrontmatter = {
  /** The text between the opening and closing `---` fences. */
  frontmatter: string;
  /** Everything after the closing fence, with its leading newline removed. */
  body: string;
};

/** Split a markdown file into frontmatter and body, or null when it opens with
 *  no closing fence. */
export const markdownFrontmatter = (
  text: string,
): MarkdownFrontmatter | null => {
  const normalized = text.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  return match === null ? null : { body: match[2]!, frontmatter: match[1]! };
};

/** The frontmatter block of a markdown file, or null when the file opens with
 *  no closing fence. */
export const frontmatterBlock = (text: string): string | null =>
  markdownFrontmatter(text)?.frontmatter ?? null;
