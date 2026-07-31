/* jscpd:ignore-start -- imports */
import type { PaymentSession } from "#shared/db/payments/types.ts";
import {
  invalidProviderRead,
  missingProviderRead,
  unavailableProviderRead,
} from "#shared/payment-runtime/provider-read.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";

/* jscpd:ignore-end */

type ExtraTransportIssue<ExtraIssue extends string> = ExtraIssue extends string
  ? { status: ExtraIssue }
  : never;

export type ProviderTransportIssue<ExtraIssue extends string = never> =
  | { status: "missing" }
  | { status: "unavailable" }
  | ExtraTransportIssue<ExtraIssue>;

export type ProviderTransportResult<Value, ExtraIssue extends string = never> =
  | { status: "found"; value: Value }
  | ProviderTransportIssue<ExtraIssue>;

type ProviderTransportErrorAction<ExtraIssue extends string> =
  | "propagate"
  | ProviderTransportIssue<ExtraIssue>;

interface ProviderTransportReaderConfig<
  Client,
  ExtraIssue extends string,
  Context,
> {
  classifyError: (error: unknown) => ProviderTransportErrorAction<ExtraIssue>;
  getClient: () => Client | null | Promise<Client | null>;
  reportError: (error: unknown, context: Context) => void;
}

type ProviderLoad<Client, Value> = (client: Client) => Promise<Value>;

export type ProviderTransportReader<
  Client,
  ExtraIssue extends string,
  Context,
> = <Value>(
  load: ProviderLoad<Client, Value>,
  context: Context,
) => Promise<ProviderTransportResult<Value, ExtraIssue>>;

export const makeProviderTransportReader = <
  Client,
  ExtraIssue extends string = never,
  Context = never,
>(
  config: ProviderTransportReaderConfig<Client, ExtraIssue, Context>,
): ProviderTransportReader<Client, ExtraIssue, Context> => {
  const read: ProviderTransportReader<Client, ExtraIssue, Context> = async (
    load,
    context,
  ) => {
    const client = await config.getClient();
    if (client === null) return { status: "unavailable" };
    try {
      return { status: "found", value: await load(client) };
    } catch (error) {
      const action = config.classifyError(error);
      if (action === "propagate") throw error;
      if (action.status !== "missing") config.reportError(error, context);
      return action;
    }
  };
  return read;
};

export const transportIssueForError = <Issue extends string>(
  error: unknown,
  isMissing: (error: unknown) => boolean,
  otherwise: Issue,
): { status: "missing" } | { status: Issue } =>
  isMissing(error) ? { status: "missing" } : { status: otherwise };

type TransportCall<Client, Value, Result, Context> = (
  load: ProviderLoad<Client, Value>,
  context: Context,
) => Promise<Result>;

export interface ProviderResourceTransport<Value, LookupResult> {
  lookup: (id: string) => Promise<LookupResult>;
  retrieve: (id: string) => Promise<Value | null>;
}

export const makeProviderResourceTransport = <
  Client,
  Value,
  LookupResult,
  Context,
>(
  load: (client: Client, id: string) => Promise<Value>,
  lookup: TransportCall<Client, Value, LookupResult, Context>,
  retrieve: TransportCall<Client, Value, Value | null, Context>,
  context: Context,
): ProviderResourceTransport<Value, LookupResult> => ({
  lookup: (id) => lookup((client) => load(client, id), context),
  retrieve: (id) => retrieve((client) => load(client, id), context),
});

type InvalidProviderReadReason = Parameters<typeof invalidProviderRead>[2];
export type ProviderReadResult = { read: ProviderRead };

export const invalidProviderReadResult = (
  requested: ProviderResource,
  payment: PaymentSession | null,
  reason: InvalidProviderReadReason,
): ProviderReadResult => ({
  read: invalidProviderRead(requested, payment, reason),
});

export type ProviderReadValidator = (
  valid: boolean,
  reason: InvalidProviderReadReason,
) => ProviderReadResult | null;

export const providerReadValidator =
  (
    requested: ProviderResource,
    payment: PaymentSession | null,
  ): ProviderReadValidator =>
  (valid, reason) =>
    valid ? null : invalidProviderReadResult(requested, payment, reason);

export const providerReadForTransportIssue = (
  issue: ProviderTransportIssue<"invalid">,
  payment: PaymentSession | null,
  requested: ProviderResource,
): ProviderRead => {
  if (issue.status === "missing") {
    return missingProviderRead(payment, requested);
  }
  return issue.status === "invalid"
    ? invalidProviderRead(requested, payment, "malformed_response")
    : unavailableProviderRead(payment, requested);
};
