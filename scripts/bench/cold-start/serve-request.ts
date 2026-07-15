/** Serve one GET through the production handler and drain its body. `serve` is
 * passed in so the parent can hand over its dynamically imported handler while
 * the child hands over its statically imported one. */
export const serveAndDrain = async (
  serve: (request: Request) => Promise<Response>,
  path: string,
): Promise<{ body: string; status: number }> => {
  const response = await serve(new Request(`http://localhost${path}`));
  return { body: await response.text(), status: response.status };
};
