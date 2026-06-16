/**
 * Shared building blocks for the admin guide.
 *
 * Section/Q render the FAQ accordion structure. Faq is the data-driven form
 * that pulls its question and answer HTML from the guide.q.* and guide.a.*
 * locale keys. columnReferenceTable renders the column-tag reference tables for
 * the Column Order section.
 */

import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";

/** Host-level configuration info passed from the route */
export type GuideHostConfig = {
  hostEmailProvider: string | null;
  hostEmailFromAddress: string | null;
  hostAppleWalletPassTypeId: string | null;
  hostGoogleWalletIssuerId: string | null;
  builderEnabled: boolean;
  bunnyDnsSubdomainSuffix: string | null;
};

export const Section = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: Child;
}): JSX.Element => (
  <div class="stack-md column">
    <h3 id={id}>{title}</h3>
    {children}
  </div>
);

export const Q = ({
  q,
  children,
}: {
  q: string;
  children?: Child;
}): JSX.Element => (
  <details>
    <summary>{q}</summary>
    {children}
  </details>
);

/** Data-driven FAQ entry: question and answer HTML come from locale keys. */
export const Faq = ({ id }: { id: string }): JSX.Element => (
  <Q q={t(`guide.q.${id}`)}>
    <Raw html={t(`guide.a.${id}`)} />
  </Q>
);

/** Render a column reference table from column generators */
export const columnReferenceTable = (
  columns: Record<string, { label: string; description: string }>,
): string => {
  const rows = Object.entries(columns)
    .map(
      ([key, col]) =>
        `<tr>
          <td><code>{{${key}}}</code></td>
          <td>${col.label}</td>
          <td>${col.description}</td>
        </tr>`,
    )
    .join("");
  return [
    "<table>",
    "<thead><tr><th>Tag</th><th>Label</th><th>Description</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
};
