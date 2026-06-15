/**
 * Public "pay your remaining balance" page. PII-free: it recaps the booked
 * products and the amount due (read from plaintext data), never the customer's
 * personal details.
 */

import { formatCurrency } from "#shared/currency.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** Recap + pay form for an outstanding balance. */
export const balancePaymentPage = (
  token: string,
  amount: number,
  summary: OrderSummary,
): string =>
  String(
    <Layout title="Pay your balance">
      <div class="prose">
        <h1>Pay your balance</h1>
        <p>Here's a summary of your booking. No personal details are shown.</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>
          {summary.lines.map((line) => (
            <tr>
              <td>{line.name}</td>
              <td>{line.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <strong>Already paid:</strong> {formatCurrency(summary.depositPaid)}
      </p>
      <p>
        <strong>Balance due:</strong> {formatCurrency(amount)}
      </p>
      <CsrfForm action={`/pay/${token}`}>
        <SubmitButton icon="save">
          Pay {formatCurrency(amount)} now
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** Shown when the link is valid but there is nothing left to pay. */
export const balanceSettledPage = (): string =>
  String(
    <Layout title="Nothing to pay">
      <div class="prose">
        <h1>Nothing to pay</h1>
        <p>This booking has no outstanding balance. Thank you!</p>
      </div>
    </Layout>,
  );

/** Shown when the link is invalid or expired. */
export const balanceInvalidPage = (): string =>
  String(
    <Layout title="Link not valid">
      <div class="prose">
        <h1>This payment link is not valid</h1>
        <p>
          The link may have expired or been mistyped. Please ask the organiser
          for a new one.
        </p>
      </div>
    </Layout>,
  );
