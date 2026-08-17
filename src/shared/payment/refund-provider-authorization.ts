/** The unforgeable permit carried by every provider refund call. */

import * as v from "valibot";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import { requireRefundGeneration } from "#shared/payment/refund-generation.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Whether one exact provider request may safely be repeated. */
export const RefundProviderCapabilitySchema = v.picklist(["keyed", "keyless"]);
export type RefundProviderCapability = v.InferOutput<
  typeof RefundProviderCapabilitySchema
>;

/** Each provider declares the kind of durable retry authority it supports. */
export const REFUND_PROVIDER_CAPABILITIES = {
  square: "keyed",
  stripe: "keyed",
  sumup: "keyless",
} as const satisfies Record<PaymentProviderType, RefundProviderCapability>;

type KeyedProvider = {
  [Provider in PaymentProviderType]: (typeof REFUND_PROVIDER_CAPABILITIES)[Provider] extends "keyed"
    ? Provider
    : never;
}[PaymentProviderType];

type KeylessProvider = Exclude<PaymentProviderType, KeyedProvider>;

type RefundSendIdentity<Provider extends PaymentProviderType> = {
  readonly generation: number;
  readonly identityIndex: string;
  readonly provider: Provider;
};

export type KeyedRefundAuthorization<
  Provider extends KeyedProvider = KeyedProvider,
> = RefundSendIdentity<Provider> & {
  readonly capability: "keyed";
  readonly idempotencyKey: string;
};

export type KeylessRefundAuthorization<
  Provider extends KeylessProvider = KeylessProvider,
> = RefundSendIdentity<Provider> & {
  readonly capability: "keyless";
};

interface RefundAuthorizationByProvider {
  readonly square: KeyedRefundAuthorization<"square">;
  readonly stripe: KeyedRefundAuthorization<"stripe">;
  readonly sumup: KeylessRefundAuthorization<"sumup">;
}

export type RefundAuthorization<
  Provider extends PaymentProviderType = PaymentProviderType,
> = RefundAuthorizationByProvider[Provider];

const durableRefundPermit: unique symbol = Symbol("durable refund permit");

type AuthorizedRefundRequestFor<Authorization extends RefundAuthorization> =
  RefundRequest & {
    readonly authorization: Authorization;
    readonly [durableRefundPermit]: true;
  };

/** A request that the durable refund authority has explicitly armed. */
export type AuthorizedRefundRequest<
  Provider extends PaymentProviderType = PaymentProviderType,
> = AuthorizedRefundRequestFor<RefundAuthorization<Provider>>;

const requireText = (value: string, name: string): void => {
  if (value.length === 0) throw new Error(`Refund ${name} must not be blank`);
};

/**
 * Mint the provider-bound permit after the durable authority has armed it.
 * Production imports are restricted to that authority by a code-quality gate.
 */
export const authorizeDurableRefundSend = <
  Authorization extends RefundAuthorization,
>(
  request: RefundRequest,
  authorization: Authorization,
): AuthorizedRefundRequestFor<Authorization> => {
  requireRefundGeneration(authorization.generation);
  requireText(authorization.identityIndex, "identity index");
  if (
    authorization.capability !==
    REFUND_PROVIDER_CAPABILITIES[authorization.provider]
  ) {
    throw new Error("Refund authorization does not match its provider");
  }
  if (authorization.capability === "keyed") {
    requireText(authorization.idempotencyKey, "idempotency key");
  }

  const sealedAuthorization: Authorization = Object.freeze({
    ...authorization,
  });
  const authorized: AuthorizedRefundRequestFor<Authorization> = {
    authorization: sealedAuthorization,
    ...request,
    [durableRefundPermit]: true,
  };
  Object.defineProperty(authorized, durableRefundPermit, {
    enumerable: false,
    value: true,
  });
  return Object.freeze(authorized);
};

/** Refuse a permit minted for a different provider before any network call. */
export function requireProviderRefundAuthorization<
  Provider extends PaymentProviderType,
>(
  request: AuthorizedRefundRequest,
  provider: Provider,
): asserts request is AuthorizedRefundRequest<Provider> {
  if (
    request[durableRefundPermit] !== true ||
    request.authorization.provider !== provider ||
    request.authorization.capability !== REFUND_PROVIDER_CAPABILITIES[provider]
  ) {
    throw new Error(`Refund authorization does not permit ${provider}`);
  }
}
