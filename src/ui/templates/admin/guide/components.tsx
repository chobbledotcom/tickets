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

/**
 * The guide as data.
 *
 * The page is a flat, ordered list of {@link GuideSection}s, each owning a flat
 * list of {@link GuideEntry}s. The types make the structure explicit so it
 * cannot drift: a section's `entries` are FAQs/custom Q&As only — an entry can
 * never itself be a section. That removes a whole class of layout bug where a
 * sub-section authored in the middle of another section's entries renders its
 * `<h3>` mid-list, pulling every later entry under the wrong heading. New
 * sections go in the top-level array (see `guideSections` in ../guide.tsx);
 * there is simply nowhere to "nest" one incorrectly.
 */

/** A FAQ entry whose question and answer come from guide.q.* / guide.a.* keys. */
export type GuideFaq = { faq: string };

/** A hand-authored entry: a question with a bespoke answer body, used where the
 * answer depends on host configuration or contains rich/structured HTML. */
export type GuideCustom = { question: string; body: JSX.Element };

/** One entry beneath a section heading — never a section itself. */
export type GuideEntry = GuideFaq | GuideCustom;

/** A guide section: one <h3> heading and the flat list of entries under it. */
export type GuideSection = {
  id?: string;
  title: string;
  entries: GuideEntry[];
};

/** Author a data-driven FAQ entry from its locale-key id. */
export const faq = (id: string): GuideFaq => ({ faq: id });

/** Author a custom question/answer entry with a bespoke body. */
export const custom = (question: string, body: JSX.Element): GuideCustom => ({
  body,
  question,
});

const renderEntry = (entry: GuideEntry): JSX.Element =>
  "faq" in entry ? (
    <Faq id={entry.faq} />
  ) : (
    <Q q={entry.question}>{entry.body}</Q>
  );

/** Render the guide from its schema: one <Section> per section, in order. */
export const renderGuideSections = (sections: GuideSection[]): JSX.Element => (
  <>
    {sections.map((section) => (
      <Section id={section.id} title={section.title}>
        {section.entries.map(renderEntry)}
      </Section>
    ))}
  </>
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
