/** The system-map page template: one section per declared machine.
 *
 * The page is complete without JavaScript — every state and its ways forward
 * are rendered as a list. The interactive diagram is a progressive
 * enhancement: the same data, with labels already resolved, is embedded once
 * as JSON and `client/admin/schema-atlas.ts` turns it into an SVG map. */

import { t } from "#i18n";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import type { AtlasActor } from "#shared/schema-atlas/types.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { settingsArticlePage } from "#templates/admin/settings/page-shell.tsx";
import { JsonScript } from "#templates/components/json-script.tsx";

const ACTOR_CLASS: Record<AtlasActor, string> = {
  owner: "schema-actor-owner",
  provider: "schema-actor-provider",
  system: "schema-actor-system",
};

type ViewEdge = {
  readonly actor: AtlasActor;
  readonly label: string;
  readonly to: string;
  readonly toLabel: string;
};

type ViewState = {
  readonly detail: string;
  readonly edges: readonly ViewEdge[];
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly id: string;
  readonly label: string;
  readonly layout: { readonly x: number; readonly y: number };
  readonly start: boolean;
};

type ViewMachine = {
  readonly id: string;
  readonly intro: string;
  readonly states: readonly ViewState[];
  readonly title: string;
};

/** Resolve every catalog key once, server-side: the client script receives
 * finished words and does no translation work. Label lookups are guaranteed
 * by construction — the map is built from the same states the edges name. */
const viewMachine = (
  machine: (typeof SCHEMA_ATLAS_MACHINES)[number],
): ViewMachine => {
  const labels = new Map(
    machine.states.map((state) => [state.id, t(state.labelKey)]),
  );
  return {
    id: machine.id,
    intro: t(machine.introKey),
    states: machine.states.map((state) => ({
      detail: t(state.detailKey),
      edges: state.edges.map((edge) => ({
        actor: edge.actor,
        label: t(edge.labelKey),
        to: edge.to,
        toLabel: labels.get(edge.to)!,
      })),
      facts: state.facts.map((fact) => ({
        label: t(fact.labelKey),
        value: fact.value,
      })),
      id: state.id,
      label: labels.get(state.id)!,
      layout: state.layout,
      start: state.start === true,
    })),
    title: t(machine.titleKey),
  };
};

/** One state's static entry: what it means, what the code says clears it,
 * and every way the record can move next. */
const StateArticle = ({ state }: { state: ViewState }): JSX.Element => (
  <article class="schema-state" data-schema-state={state.id}>
    <h3>
      {state.label}
      {state.start && ` · ${t("schema.state.start")}`}
    </h3>
    <p>{state.detail}</p>
    {state.facts.length > 0 && (
      <dl class="schema-facts">
        {state.facts.map((fact) => (
          <>
            <dt>{fact.label}</dt>
            <dd>
              <code>{fact.value}</code>
            </dd>
          </>
        ))}
      </dl>
    )}
    <h4>{t("schema.list.heading")}</h4>
    {state.edges.length === 0 ? (
      <p>{t("schema.list.none")}</p>
    ) : (
      <ul>
        {state.edges.map((edge) => (
          <li>
            <span class={`schema-actor ${ACTOR_CLASS[edge.actor]}`}>
              {t(`schema.actor.${edge.actor}`)}
            </span>
            {`: ${edge.label} → ${edge.toLabel}`}
          </li>
        ))}
      </ul>
    )}
  </article>
);

/** One machine: its diagram mount (filled in by the client) and its full
 * static list. */
const MachineSection = ({ machine }: { machine: ViewMachine }): JSX.Element => (
  <section
    class="schema-machine"
    data-schema-atlas-machine={machine.id}
    id={machine.id}
  >
    <h2>{machine.title}</h2>
    <p>{machine.intro}</p>
    <div class="schema-widget" data-schema-atlas={machine.id} hidden />
    <p class="schema-widget-hint">{t("schema.widget.hint")}</p>
    {machine.states.map((state) => (
      <StateArticle state={state} />
    ))}
  </section>
);

export const adminSchemaAtlasPage = (
  session: AdminSession,
  theme: Theme,
): string => {
  const machines = SCHEMA_ATLAS_MACHINES.map(viewMachine);
  return settingsArticlePage(
    "schema.title",
    "schema.title",
    "schema.intro",
    "/admin/schema",
  )(
    session,
    theme,
  )(
    <>
      <div class="prose">
        <p class="schema-legend">
          <strong>{t("schema.legend.heading")}</strong>{" "}
          {(["system", "provider", "owner"] as const).map((actor, index) => (
            <>
              {index > 0 && ", "}
              <span class={`schema-actor ${ACTOR_CLASS[actor]}`}>
                {t(`schema.legend.${actor}`)}
              </span>
            </>
          ))}
          .
        </p>
        {machines.map((machine) => (
          <MachineSection machine={machine} />
        ))}
      </div>
      <JsonScript id="schema-atlas-data" value={{ machines }} />
    </>,
  );
};
