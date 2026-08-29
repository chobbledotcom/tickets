/**
 * Shared building blocks for the admin guide.
 *
 * Section/Q render the FAQ accordion structure. Faq is the data-driven form
 * that pulls its question and answer HTML from the guide.q.* and guide.a.*
 * locale keys.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { sectionsRenderer } from "#templates/components/aggregate-sections.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import type { TitledBlock } from "#templates/components/titled-block.ts";
/* jscpd:ignore-end */

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
}: { id?: string | undefined } & TitledBlock): JSX.Element => (
  <PageBlock>
    <h3 id={id}>{title}</h3>
    {children}
  </PageBlock>
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

/** A labelled block of example code, bold callout then `<pre>`: the shape
 * every guide example shows. Owning it here keeps the pair of lines from
 * being re-authored (and re-detected as clones) per example. */
export const ExampleCode = ({
  label,
  code,
}: {
  label: Child;
  code: string;
}): JSX.Element => (
  <>
    <p>
      <strong>{label}</strong>
    </p>
    <pre>
      <code>{code}</code>
    </pre>
  </>
);

/** Data-driven FAQ entry: question and answer HTML come from locale keys. */
export const Faq = ({ id }: { id: string }): JSX.Element => (
  <Q q={t(`guide.q.${id}`)}>
    <Raw html={t(`guide.a.${id}`)} />
  </Q>
);

/**
 * The guide as data: a flat, ordered list of {@link GuideSection}s, each owning
 * a flat list of {@link GuideEntry}s. An entry can never itself be a section.
 * That removes a class of layout bug where a sub-section authored mid-list
 * renders its heading there and pulls every later entry under it.
 *
 * All copy lives in the locale. A section's heading comes from
 * `guide.sections.<titleKey>`, and an entry's question from `guide.q.<id>`.
 * `faq(id)` renders its answer from `guide.a.<id>`, and `custom(id, body)`
 * supplies a bespoke body for dynamic content.
 */

/** A FAQ entry whose question and answer come from guide.q.* / guide.a.* keys. */
export type GuideFaq = { faq: string };

/** A hand-authored entry: a `guide.q.<custom>` question with a bespoke answer
 * body, used where the answer depends on host configuration or contains
 * rich/structured HTML that cannot be a static locale string. */
export type GuideCustom = { custom: string; body: JSX.Element };

/** One entry beneath a section heading — never a section itself. */
export type GuideEntry = GuideFaq | GuideCustom;

/** A guide section: one <h3> heading (from guide.sections.<titleKey>) and the
 * flat list of entries under it. */
export type GuideSection = {
  id?: string;
  titleKey: string;
  entries: GuideEntry[];
};

/** Author a data-driven FAQ entry from its locale-key id. */
export const faq = (id: string): GuideFaq => ({ faq: id });

/** Author a custom entry: a localized question plus a bespoke answer body. */
export const custom = (id: string, body: JSX.Element): GuideCustom => ({
  body,
  custom: id,
});

const renderEntry = (entry: GuideEntry): JSX.Element =>
  "faq" in entry ? (
    <Faq id={entry.faq} />
  ) : (
    <Q q={t(`guide.q.${entry.custom}`)}>{entry.body}</Q>
  );

/** Render the guide from its schema: one <Section> per section, in order. */
export const renderGuideSections: (
  sections: readonly GuideSection[],
) => JSX.Element = sectionsRenderer((section: GuideSection) => (
  <Section id={section.id} title={t(`guide.sections.${section.titleKey}`)}>
    {section.entries.map(renderEntry)}
  </Section>
));
