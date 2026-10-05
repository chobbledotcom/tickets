/**
 * Run inside one request context, the way the entry pipeline does. The test
 * fixture for anything that reads request state: locale, client IP, request
 * id, trace, iframe mode.
 */

import { runWithRequestContext } from "#shared/request-context.ts";

const TEST_REQUEST = new Request("https://example.com/test");
const IFRAME_REQUEST = new Request("https://example.com/test?iframe=true");

/** Run `fn` inside one request context with the given facts. */
export const withRequestContext = <T>(
  fn: () => T,
  options: { clientIp?: string; iframe?: boolean; locale?: string } = {},
): Promise<T> =>
  runWithRequestContext(
    options.iframe ? IFRAME_REQUEST : TEST_REQUEST,
    {
      clientIp: options.clientIp ?? "203.0.113.7",
      locale: options.locale ?? "en",
    },
    async () => fn(),
  );
