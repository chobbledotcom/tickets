// effects: pure
/** The frontmatter block of one markdown file.
 *
 *  Every reader shares one normalisation: Windows line endings read like Unix
 *  ones, so a file edited on any machine parses the same way. */

/** The text between the opening and closing `---` fences, or null when the
 *  file opens with no closing fence. */
export const frontmatterBlock = (text: string): string | null => {
  const normalized = text.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return match === null ? null : match[1]!;
};
