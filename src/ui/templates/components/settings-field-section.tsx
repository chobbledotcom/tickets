/**
 * Factories for the single-field settings sections.
 *
 * Several settings sections are the same {@link SettingsSection} shell wrapped
 * around exactly one field: a labelled text input (business email, embed hosts)
 * or a single textarea (terms, custom CSS). These factories own that shape so
 * each section only declares its copy, field name, and how to read its value
 * from the page state — rather than re-hand-rolling the wrapper per section.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";

type SectionCopy = {
  action: string;
  title: string;
  description: Child;
  submitLabel: string;
};

/** Copy shared by both single-field section factories. */
type FieldCopy<S> = SectionCopy & {
  label: Child;
  name: string;
  placeholder?: string;
  getValue: (state: S) => string;
};

/**
 * Build a single-field section factory: wrap the {@link SettingsSection} shell
 * around whatever `build` renders from the config and the current page state.
 * Owning this curry once keeps the two field factories to a single expression.
 */
const singleFieldSection =
  <S, C extends SectionCopy>(build: (cfg: C, state: S) => Child) =>
  (cfg: C) =>
  (state: S): JSX.Element => (
    <SettingsSection
      action={cfg.action}
      description={cfg.description}
      submitLabel={cfg.submitLabel}
      title={cfg.title}
    >
      {build(cfg, state)}
    </SettingsSection>
  );

/** A settings section holding a single labelled text input. */
export const textSettingsSection = <S,>(
  cfg: FieldCopy<S> & {
    type: string;
    /** Optional note rendered under the input (e.g. wildcard hint). */
    footer?: Child;
  },
) =>
  singleFieldSection<S, typeof cfg>((c, state) => [
    <TextField
      label={c.label}
      name={c.name}
      placeholder={c.placeholder}
      type={c.type}
      value={c.getValue(state)}
    />,
    c.footer,
  ])(cfg);

/** A settings section holding a single textarea. */
export const textareaSettingsSection = <S,>(
  cfg: FieldCopy<S> & {
    /** Extra content rendered inside the `<label>`, after the label text. */
    labelHint?: Child;
    /** Enable the client-side markdown preview on the textarea. */
    markdownPreview?: boolean;
  },
) =>
  singleFieldSection<S, typeof cfg>((c, state) => (
    <label>
      {c.label}
      {c.labelHint}
      <textarea
        {...(c.markdownPreview ? { "data-markdown-preview": true } : {})}
        maxlength={MAX_TEXTAREA_LENGTH}
        name={c.name}
        placeholder={c.placeholder}
      >
        {c.getValue(state)}
      </textarea>
    </label>
  ))(cfg);
