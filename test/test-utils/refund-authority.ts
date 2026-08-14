import {
  type ReadyRefundState,
  readyRefund,
} from "#shared/payment/refund-authority.ts";

export interface ReadyRefundTestOptions {
  readonly evidenceRevision?: number;
  readonly identityIndex?: string;
  readonly nextActionAt?: number;
  readonly now?: number;
  readonly replayUntil?: number;
}

/** Build a keyed or keyless ready generation with explicit, stable test time. */
export const readyRefundForTest = (
  capability: "keyed" | "keyless",
  options: ReadyRefundTestOptions = {},
): ReadyRefundState => {
  const now = options.now ?? 100;
  const request =
    capability === "keyless"
      ? {
          capability,
          generation: 1,
          identityIndex: options.identityIndex ?? "request-one",
        }
      : {
          capability,
          generation: 1,
          identityIndex: options.identityIndex ?? "request-one",
          replayUntil: options.replayUntil ?? 500,
        };
  return readyRefund({
    evidenceRevision: options.evidenceRevision ?? 4,
    nextActionAt: options.nextActionAt ?? 110,
    now,
    request,
  });
};
