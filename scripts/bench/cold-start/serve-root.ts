/** Serve `GET /` through the production handler and drain the body, returning
 * the response. `serve` is passed in so the parent can hand over its
 * dynamically imported handler (nothing may read the environment before it sets
 * it) while the child hands over its statically imported one. Both the parent's
 * warm-up prep and the child's timed requests hit the root request one way. */
export const serveAndDrainRoot = async (
  serve: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const response = await serve(new Request("http://localhost/"));
  await response.text();
  return response;
};
