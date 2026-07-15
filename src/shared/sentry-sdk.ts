/**
 * The narrow Sentry surface used by the server error reporter.
 *
 * Keeping named SDK imports behind this lazy-loaded adapter lets esbuild remove
 * unused Sentry exports without evaluating the SDK during module load.
 */

import {
  createStackParser,
  createTransport,
  nodeStackLineParser,
} from "@sentry/core";
import {
  captureException,
  captureMessage,
  DenoClient,
  flush,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  isInitialized,
} from "@sentry/deno";

type InitOptions = {
  dsn: string;
  release: string | undefined;
};

const fetchBody = (body: string | Uint8Array): BodyInit => body.slice();

/** Send envelopes while the SDK's public transport keeps buffering and limits. */
const makeFetchTransport: ConstructorParameters<
  typeof DenoClient
>[0]["transport"] = (options) =>
  createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      body: fetchBody(request.body),
      headers: new Headers(options.headers),
      method: "POST",
      referrerPolicy: "strict-origin",
    });
    return {
      headers: {
        "retry-after": response.headers.get("retry-after"),
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
      },
      statusCode: response.status,
    };
  });

const init = (options: InitOptions): DenoClient => {
  const client = new DenoClient({
    ...options,
    integrations: [],
    stackParser: createStackParser(nodeStackLineParser()),
    tracesSampleRate: 0,
    transport: makeFetchTransport,
  });
  getCurrentScope().setClient(client);
  client.init();
  return client;
};

export const sentrySdk = {
  captureException,
  captureMessage,
  flush,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  init,
  isInitialized,
};
