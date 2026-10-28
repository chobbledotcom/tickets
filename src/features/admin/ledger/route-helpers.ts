import { pageFoundOr404 } from "#routes/admin/page-route.ts";
import type { AuthSession } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";

export const pageHtml = (
  pattern: string,
  request: Request,
  render: (session: AuthSession) => string | null | Promise<string | null>,
): Promise<Response> =>
  pageFoundOr404(
    pattern,
    request,
    (session) => Promise.resolve(render(session)),
    (html) => htmlResponse(html),
  );

type TypeRefParams = { ref: string; type: string };

export const pageTypeRefHtml =
  (pattern: string) =>
  (
    render: (
      request: Request,
      session: AuthSession,
      params: TypeRefParams,
    ) => string | null | Promise<string | null>,
  ) =>
  (request: Request, params: TypeRefParams): Promise<Response> =>
    pageHtml(pattern, request, (session) => render(request, session, params));
