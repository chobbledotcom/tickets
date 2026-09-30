import { stub } from "@std/testing/mock";

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
