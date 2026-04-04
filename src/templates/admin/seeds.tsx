/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { CsrfForm, Flash } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Seed Data">
      <AdminNav session={session} active="" />
      <CsrfForm action="/admin/seeds">
        <h1>Seed Data</h1>
        <p>
          Create sample events and attendees from demo data. Useful for testing
          and development.
        </p>
        <Flash error={error} success={success} />
        <label for="event_count">Number of events</label>
        <input
          type="number"
          id="event_count"
          name="event_count"
          value="5"
          min="1"
          max="30"
          required
        />

        <label for="attendees_per_event">Attendees per event</label>
        <input
          type="number"
          id="attendees_per_event"
          name="attendees_per_event"
          value="10"
          min="0"
          max="1000"
          required
        />

        <button type="submit">Create Seed Data</button>
      </CsrfForm>

      <p>
        <a href="/admin">&larr; Back to dashboard</a>
      </p>
    </Layout>,
  );
