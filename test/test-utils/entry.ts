import { stub } from "@std/testing/mock";
import { bunnyServeHandler } from "#src/serve-app.ts";

/** Import an entry file with `Deno.serve` stubbed, and answer the arguments of
 * each serve call. A query string gives each call a fresh module instance. */
export const importEntry = async (
  path: string,
  instance: string,
): Promise<unknown[][]> => {
  const serve = stub(
    Deno,
    "serve",
    () => ({}) as Deno.HttpServer<Deno.NetAddr>,
  );
  try {
    await import(`${path}?${instance}`);
    return serve.calls.map((call) => call.args);
  } finally {
    serve.restore();
  }
};

/** Serve a request through the Bunny entry as the CDN sends it, with the
 * client address in `x-real-ip`. */
export const serveFromBunny = (
  request: Request,
  ip = "192.0.2.1",
): Promise<Response> => {
  request.headers.set("x-real-ip", ip);
  return bunnyServeHandler(request);
};
