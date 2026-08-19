/* jscpd:ignore-start -- imports */
import { malformedProviderRead } from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { squareReadFailure } from "#shared/square/outcomes.ts";

/* jscpd:ignore-end */

type SquareRead<Client, Wire, Raw, Resource> = {
  read: (client: Client) => Promise<Wire>;
  resource: (raw: Wire) => Raw | null | undefined;
  parse: (raw: Raw) => Resource | null;
  matches: (resource: Resource) => boolean;
  accepts?: ((resource: Resource) => boolean) | undefined;
};

/** Read one configured Square resource through the shared strict boundary. */
export const readSquareResource = async <Client, Wire, Raw, Resource>(
  client: Client | null,
  reader: SquareRead<Client, Wire, Raw, Resource>,
): Promise<ProviderRead<Resource>> => {
  if (client === null) {
    return { reason: "not_configured", status: "unavailable" };
  }
  try {
    const raw = reader.resource(await reader.read(client));
    if (raw === null || raw === undefined) {
      return { reason: "missing_documented_resource", status: "invalid" };
    }
    const resource = reader.parse(raw);
    if (resource === null) return malformedProviderRead();
    if (!reader.matches(resource)) {
      return { reason: "mismatched_id", status: "invalid" };
    }
    if (reader.accepts !== undefined && !reader.accepts(resource)) {
      return { reason: "unsupported_status", status: "invalid" };
    }
    return { resource, status: "found" };
  } catch (error) {
    const failure = squareReadFailure(error);
    if (failure !== undefined) return failure;
    throw error;
  }
};
