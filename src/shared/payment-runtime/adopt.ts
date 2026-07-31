import {
  getLegacyPaymentsByReferences,
  type LegacyPaymentReplay,
} from "#shared/db/payments/legacy-sessions.ts";
import {
  adoptPaymentSession,
  getPaymentSessionsPrimary,
} from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { matchLegacyPayment } from "#shared/payment-runtime/locate.ts";
import { invalidProviderRead } from "#shared/payment-runtime/provider-read.ts";
import {
  storedPaymentFactIssue,
  storedPaymentFacts,
} from "#shared/payment-state/facts.ts";
import {
  type ProviderRead,
  stagedPaymentOwnership,
} from "#shared/payment-state/observation.ts";

export interface PaymentForFoundRead {
  payment: PaymentSession;
  read: ProviderRead;
}

export type PaymentForRead =
  | PaymentForFoundRead
  | { conflict: true }
  | { legacy: LegacyPaymentReplay };

type FoundProviderRead = Extract<ProviderRead, { status: "found" }>;

const stagedFoundRead = (
  payment: PaymentSession,
  read: FoundProviderRead,
): PaymentForFoundRead => {
  if (payment.provider !== read.observation.session.provider) {
    throw new Error(`Payment ${payment.id} was returned by the wrong provider`);
  }
  const withSession = { ...payment, session: read.observation.session };
  const issue = storedPaymentFactIssue(payment, read.observation);
  if (issue !== null) {
    return {
      payment: withSession,
      read: invalidProviderRead(read.requested, withSession, issue),
    };
  }
  return {
    payment: withSession,
    read: {
      ...read,
      observation: {
        ...read.observation,
        ...storedPaymentFacts(payment),
        ownership: stagedPaymentOwnership(
          payment.id,
          read.observation.session.id,
        ),
      },
    },
  };
};

export const paymentForFoundRead = async (
  read: FoundProviderRead,
): Promise<PaymentForRead> => {
  const ownership = read.observation.ownership;
  const [payment] = await getPaymentSessionsPrimary([ownership.localPaymentId]);
  if (payment !== undefined && payment !== null) {
    return stagedFoundRead(payment, read);
  }
  if (ownership.method === "staged") {
    throw new Error(`Staged payment ${ownership.localPaymentId} was not found`);
  }
  const legacyResource = read.observation.session;
  const legacy = await matchLegacyPayment(
    await getLegacyPaymentsByReferences([
      legacyResource.id,
      ownership.localPaymentId,
    ]),
    legacyResource,
  );
  if (legacy.conflict) return { conflict: true };
  if (legacy.legacy !== null) return { legacy: legacy.legacy };
  return {
    payment: await adoptPaymentSession(
      {
        accountId: read.observation.accountId,
        bookingIntent: read.observation.bookingIntent,
        checkoutCreate: null,
        expected: read.observation.expected,
        id: ownership.localPaymentId,
        mode: read.observation.mode,
        provider: read.observation.session.provider,
        session: read.observation.session,
      },
      Date.parse(read.observation.createdAt),
    ),
    read,
  };
};
