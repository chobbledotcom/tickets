/**
 * A payment provider's part in a refund story.
 *
 * The application still chooses and loads the real provider adapters. This
 * script replaces only their two external facts: what a charge currently says
 * and what happened when a refund was sent. A story that forgot either fact
 * fails at that boundary instead of accidentally reaching a network.
 */

// jscpd:ignore-start
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import type { PutsThingsBack } from "#test/specs/support/memory.ts";

// jscpd:ignore-end

type ChargeAnswer = ProviderRead<ChargeMoney>;
type RefundAnswer =
  | RefundAttemptResult
  | ((
      request: RefundRequest,
    ) => RefundAttemptResult | Promise<RefundAttemptResult>);

type RefundPlan = readonly [
  provider: PaymentProviderType,
  reference: string,
  answer: RefundAnswer,
  afterward?: ChargeAnswer,
];

type PlannedRefund = {
  readonly answer: RefundAnswer;
  readonly afterward?: ChargeAnswer;
};

export type ProviderReadCall = {
  readonly provider: PaymentProviderType;
  readonly reference: string;
};

export type ProviderRefundCall = ProviderReadCall & {
  readonly request: RefundRequest;
};

/** A provider answer deliberately held open to create genuine request overlap. */
export interface PausedProviderRefund {
  /** Settles after the provider method has handed its answer back. */
  readonly finished: Promise<void>;
  /** Let the held external answer return. Safe to call again during cleanup. */
  release(): void;
  /** The exact request once the application reaches the provider. */
  readonly started: Promise<RefundRequest>;
}

export interface RefundProviderScript {
  /** Queue one answer to a refund send, optionally changing later reads. */
  answer(...plan: RefundPlan): void;

  /** Add real stored credentials, making these providers discoverable. */
  giveCredentials(...providers: PaymentProviderType[]): Promise<void>;

  /** Queue one refund answer but hold it until the story releases it. */
  pause(...plan: RefundPlan): PausedProviderRefund;

  readCount(provider?: PaymentProviderType, reference?: string): number;
  readonly reads: readonly ProviderReadCall[];
  sendCount(provider?: PaymentProviderType, reference?: string): number;
  readonly sends: readonly ProviderRefundCall[];

  /** Say exactly what one provider currently reports about one charge. */
  show(
    provider: PaymentProviderType,
    reference: string,
    answer: ChargeAnswer,
  ): void;

  /** The common successful charge read. */
  showCharge(
    provider: PaymentProviderType,
    reference: string,
    charge: ChargeMoney,
  ): void;

  /** Select a credentialed provider for new payments. */
  useForNewPayments(provider: PaymentProviderType): Promise<void>;
}

const PROVIDERS = {
  square: squarePaymentProvider,
  stripe: stripePaymentProvider,
  sumup: sumupPaymentProvider,
} as const satisfies Record<PaymentProviderType, PaymentProvider>;

const giveCredential = {
  square: () => settings.update.square.accessToken("square_refund_story"),
  stripe: () => settings.update.stripe.secretKey("sk_test_refund_story"),
  sumup: () => settings.update.sumup.apiKey("sumup_refund_story"),
} satisfies Record<PaymentProviderType, () => Promise<void>>;

const keyOf = (provider: PaymentProviderType, reference: string): string =>
  `${provider}:${reference}`;

const answersFor = (
  queued: Map<string, PlannedRefund[]>,
  provider: PaymentProviderType,
  reference: string,
): PlannedRefund => {
  const key = keyOf(provider, reference);
  const answers = queued.get(key);
  const answer = answers?.shift();
  if (answer === undefined) {
    throw new Error(
      `The story gave ${provider} no refund answer for ${reference}`,
    );
  }
  if (answers?.length === 0) queued.delete(key);
  return answer;
};

const callRefundAnswer = (
  answer: RefundAnswer,
  request: RefundRequest,
): Promise<RefundAttemptResult> =>
  Promise.resolve(typeof answer === "function" ? answer(request) : answer);

const countsMatching = (
  calls: readonly ProviderReadCall[],
  provider?: PaymentProviderType,
  reference?: string,
): number =>
  calls.filter(
    (call) =>
      (provider === undefined || call.provider === provider) &&
      (reference === undefined || call.reference === reference),
  ).length;

const forEveryProvider = <Result>(
  use: (providerName: PaymentProviderType, provider: PaymentProvider) => Result,
): Result[] =>
  (Object.keys(PROVIDERS) as PaymentProviderType[]).map((providerName) =>
    use(providerName, PROVIDERS[providerName]),
  );

/** Install one scenario-long provider script and register every restoration. */
export const installRefundProviderScript = (
  cleanup: Pick<PutsThingsBack, "add">,
): RefundProviderScript => {
  const chargeAnswers = new Map<string, ChargeAnswer>();
  const refundAnswers = new Map<string, PlannedRefund[]>();
  const reads: ProviderReadCall[] = [];
  const sends: ProviderRefundCall[] = [];

  const readStubs = forEveryProvider((providerName, provider) =>
    stub(provider, "readCharge", (reference: string) => {
      reads.push({ provider: providerName, reference });
      const answer = chargeAnswers.get(keyOf(providerName, reference));
      if (answer === undefined) {
        throw new Error(
          `The story gave ${providerName} no charge facts for ${reference}`,
        );
      }
      return Promise.resolve(answer);
    }),
  );
  const refundStubs = forEveryProvider((providerName, provider) =>
    stub(provider, "refundCharge", async (request: RefundRequest) => {
      const reference = request.paymentReference;
      sends.push({ provider: providerName, reference, request });
      const planned = answersFor(refundAnswers, providerName, reference);
      const result = await callRefundAnswer(planned.answer, request);
      if (planned.afterward !== undefined) {
        chargeAnswers.set(keyOf(providerName, reference), planned.afterward);
      }
      return result;
    }),
  );
  cleanup.add(
    ...[...readStubs, ...refundStubs].map(
      (installed) => () => installed.restore(),
    ),
  );

  const queueRefund = (
    ...[provider, reference, answer, afterward]: RefundPlan
  ): void => {
    const key = keyOf(provider, reference);
    refundAnswers.set(key, [
      ...(refundAnswers.get(key) ?? []),
      {
        answer,
        ...(afterward === undefined ? {} : { afterward }),
      },
    ]);
  };

  const script: RefundProviderScript = {
    answer: queueRefund,
    giveCredentials: async (...providers) => {
      await [...new Set(providers)].reduce(
        async (done, provider): Promise<void> => {
          await done;
          await giveCredential[provider]();
        },
        Promise.resolve(),
      );
    },
    pause: (...[provider, reference, answer, afterward]) => {
      const started = Promise.withResolvers<RefundRequest>();
      const released = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      // A failed scenario must not leave a browser request waiting forever
      // while the After hook puts its provider stubs back.
      cleanup.add(() => released.resolve());
      queueRefund(
        provider,
        reference,
        async (request) => {
          started.resolve(request);
          await released.promise;
          try {
            return await callRefundAnswer(answer, request);
          } finally {
            finished.resolve();
          }
        },
        afterward,
      );
      return {
        finished: finished.promise,
        release: () => released.resolve(),
        started: started.promise,
      };
    },
    readCount: (provider, reference) =>
      countsMatching(reads, provider, reference),
    reads,
    sendCount: (provider, reference) =>
      countsMatching(sends, provider, reference),
    sends,
    show: (provider, reference, answer) => {
      chargeAnswers.set(keyOf(provider, reference), answer);
    },
    showCharge: (provider, reference, charge) => {
      script.show(provider, reference, { resource: charge, status: "found" });
    },
    useForNewPayments: async (provider) => {
      await script.giveCredentials(provider);
      await settings.update.paymentProvider(provider);
    },
  };
  return script;
};
