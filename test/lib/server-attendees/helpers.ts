import { adminGet, extractInputValue } from "#test-utils";

/** Extract merge_version from the merge preview HTML page. */
export const getMergeVersion = async (
  targetId: number,
  sourceToken: string,
): Promise<string> => {
  const page = await adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`,
  );
  const html = await page.text();
  const value = extractInputValue(html, "merge_version");
  if (value === null) throw new Error("merge_version not found in page");
  return value;
};
