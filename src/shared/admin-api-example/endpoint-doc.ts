/**
 * The pieces every documented endpoint is built from: what a documented
 * endpoint looks like, and how its example bodies are written out.
 */

export type EndpointDoc = {
  method: string;
  path: string;
  description: string;
  request?: string;
  response: string;
};

/** Example bodies are read on a page, so they stay indented. */
export const json = (data: unknown): string => JSON.stringify(data, null, 2);
