export type DesktopRequestHandler = (request: Request) => Promise<Response>;

const redirectTo = (location: string): Response =>
  new Response(null, { headers: { location }, status: 302 });

/** Send the desktop window to setup first, then to login on later launches. */
export const createDesktopHandler =
  (handleRequest: DesktopRequestHandler): DesktopRequestHandler =>
  async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return await handleRequest(request);
    }

    url.pathname = "/setup/";
    const setupResponse = await handleRequest(new Request(url, request));
    if (setupResponse.status === 200) return redirectTo("/setup/");
    if (
      setupResponse.status === 302 &&
      setupResponse.headers.get("location") === "/"
    ) {
      return redirectTo("/admin/login");
    }
    return setupResponse;
  };
