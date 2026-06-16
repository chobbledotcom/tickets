/**
 * Admin attendee "contact" page — send a text message via the SMS gateway.
 */

import { joinStrings, map, pipe } from "#fp";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** A text-message activity-log entry, shown as conversation history. */
export type SmsHistoryItem = {
  created: string;
  message: string;
};

const HistoryRow = ({ item }: { item: SmsHistoryItem }): string =>
  String(
    <tr>
      <td>{new Date(item.created).toLocaleString()}</td>
      <td>{item.message}</td>
    </tr>,
  );

const historyTable = (history: SmsHistoryItem[]): string =>
  history.length === 0
    ? "<p>No text messages yet.</p>"
    : String(
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              <Raw
                html={pipe(
                  map((item: SmsHistoryItem) => HistoryRow({ item })),
                  joinStrings,
                )(history)}
              />
            </tbody>
          </table>
        </div>,
      );

export const attendeeContactPage = (
  { attendee, listing }: { attendee: Attendee; listing: ListingWithCount },
  session: AdminSession,
  history: SmsHistoryItem[],
  opts: { configured: boolean; success?: string; error?: string },
): string =>
  String(
    <Layout title={`Contact: ${attendee.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={opts.error} success={opts.success} />

      <p>
        <a href={`/admin/listing/${listing.id}/attendee/${attendee.id}/edit`}>
          &larr; Back to attendee
        </a>
      </p>

      <h1>Contact {attendee.name}</h1>
      <p>
        <strong>Phone:</strong> {attendee.phone || "(none on file)"}
      </p>

      {!opts.configured && (
        <div class="warning">
          The SMS gateway is not configured. An owner must set the gateway
          credentials and end-to-end key in{" "}
          <a href="/admin/settings">settings</a> before texts can be sent.
        </div>
      )}

      {attendee.phone && opts.configured && (
        <CsrfForm
          action={`/admin/listing/${listing.id}/attendee/${attendee.id}/contact`}
        >
          <h2>Send a text message</h2>
          <label for="sms-message">Message</label>
          <textarea
            id="sms-message"
            maxlength="1000"
            name="message"
            required
            rows="4"
          />
          <SubmitButton icon="check">Send text</SubmitButton>
        </CsrfForm>
      )}

      <h2>Message history</h2>
      <Raw html={historyTable(history)} />
    </Layout>,
  );
