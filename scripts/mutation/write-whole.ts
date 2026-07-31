/** Write through a sibling temp file and rename it into place, so a write
 * that dies part-way (a full disk, a killed process) can never leave the
 * live file truncated — it holds either the old text or the new. */
export const writeWholeOrNotAtAll = async (
  path: string,
  text: string,
): Promise<void> => {
  const temp = `${path}.writing`;
  await Deno.writeTextFile(temp, text);
  await Deno.rename(temp, path);
};
