import type { AuthSession } from "#routes/auth.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";

export const ownerHtml = (
  request: Request,
  render: (session: AuthSession) => string | null | Promise<string | null>,
): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const html = await render(session);
    return html === null ? notFoundResponse() : htmlResponse(html);
  });

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
