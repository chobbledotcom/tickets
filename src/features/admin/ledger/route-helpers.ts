import { ownerFoundOr404 } from "#routes/admin/owner-route.ts";
import type { AuthSession } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";

export const ownerHtml = (
  request: Request,
  render: (session: AuthSession) => string | null | Promise<string | null>,
): Promise<Response> =>
  ownerFoundOr404(
    request,
    (session) => Promise.resolve(render(session)),
    (html) => htmlResponse(html),
  );

type TypeRefParams = { ref: string; type: string };

export const ownerTypeRefHtml =
  (
    render: (
      request: Request,
      session: AuthSession,
      params: TypeRefParams,
    ) => string | null | Promise<string | null>,
  ) =>
  (request: Request, params: TypeRefParams): Promise<Response> =>
    ownerHtml(request, (session) => render(request, session, params));
