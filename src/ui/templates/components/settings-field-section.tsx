/**
 * Factories for the single-field settings sections.
 *
 * Several settings sections are the same {@link SettingsSection} shell wrapped
 * around exactly one labelled text input. This factory owns that shape so each
 * section only declares its copy and field rather than re-hand-rolling the
 * wrapper per section.
 *
 * Each factory takes a `(state) => config` builder rather than a plain config
 * object. The builder runs inside the returned renderer, so `t(...)` calls in
 * the copy resolve against the request-scoped locale on every render instead of
 * being frozen to the default locale at module-import time.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";

type SectionCopy = {
  action: string;
  title: string;
  description: Child;
  submitLabel: string;
};

/** Copy shared by both single-field section factories. */
type FieldCopy = SectionCopy & {
  label: Child;
  name: string;
  placeholder?: string;
  value: string;
};

/**
 * Build a single-field section factory: wrap the {@link SettingsSection} shell
 * around whatever `build` renders from the per-render config. Owning this curry
 * once keeps the two field factories to a single expression.
 */
const singleFieldSection =
  <S, C extends SectionCopy>(build: (cfg: C) => Child) =>
  (config: (state: S) => C) =>
  (state: S): JSX.Element => {
    const cfg = config(state);
    return (
      <SettingsSection
        action={cfg.action}
        description={cfg.description}
        submitLabel={cfg.submitLabel}
        title={cfg.title}
      >
        {build(cfg)}
      </SettingsSection>
    );
  };

/** A settings section holding a single labelled text input. */
export const textSettingsSection = <S,>(
  config: (state: S) => FieldCopy & {
    type: string;
    /** Optional note rendered under the input (e.g. wildcard hint). */
    footer?: Child;
  },
) =>
  singleFieldSection<S, ReturnType<typeof config>>((c) => [
    <TextField
      label={c.label}
      name={c.name}
      placeholder={c.placeholder}
      type={c.type}
      value={c.value}
    />,
    c.footer,
  ])(config);
