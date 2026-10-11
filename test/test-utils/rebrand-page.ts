/** Rebuild a rendered page with every pair applied. A pair whose source
 * copy is gone no-ops, and the rebrand tests' assertions catch that: they
 * pin the rebranded words themselves. */
export const rebrandedPage = (
  from: string,
  pairs: [string, string][],
): string => {
  let page = from;
  for (const [was, now] of pairs) page = page.replace(was, now);
  return page;
};
