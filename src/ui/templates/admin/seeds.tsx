/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { Raw } from "#jsx/jsx-runtime.ts";
import { seedsForm } from "#routes/admin/seeds.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Seed Data">
      <AdminNav active="" session={session} />
      <CsrfForm action="/admin/seeds">
        <h1>Seed Data</h1>
        <p>
          Create sample listings and attendees from demo data. Useful for
          testing and development.
        </p>
        <Flash error={error} success={success} />
        <Raw html={seedsForm.render()} />
        <SubmitButton icon="plus">Create Seed Data</SubmitButton>
      </CsrfForm>

      <p>
        <a href="/admin">&larr; Back to dashboard</a>
      </p>
    </Layout>,
  );
