/**
 * Small building blocks for route steps that produce a Response.
 */

/** A step that builds the response when it runs. */
export type MakeResponse = () => Response | Promise<Response>;

/** A finished route: takes the request, gives back the response. */
export type RequestRoute = (request: Request) => Promise<Response>;

/** A gate that runs the caller's action, or returns the blocked response. */
export type FeatureGate = (
  action: MakeResponse,
) => Response | Promise<Response>;

/** Build a page gate from a feature check: when the check passes, run the
 * caller's action; when it fails, return the blocked response instead (a 404
 * outside demo mode, a "storage is off" redirect, and so on). */
export const featureGate =
  (isOn: () => boolean, blocked: () => Response): FeatureGate =>
  (action: MakeResponse): Response | Promise<Response> =>
    isOn() ? action() : blocked();
