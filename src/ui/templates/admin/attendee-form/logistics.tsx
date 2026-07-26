import { t } from "#i18n";
import {
  type AttendeeLogisticsData,
  endAgentField,
  endTimeField,
  SPLIT_AGENTS_FIELD,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";

type LogisticsAssignmentProps = {
  agents: AttendeeLogisticsData["agents"];
  assignment: AttendeeLogisticsData["single"];
  listingId?: number | undefined;
};

type LogisticsLegName = "start" | "end";

type LogisticsLegDetails = {
  agentField: typeof startAgentField;
  agentId: number | null;
  agentLabel: string;
  label: string;
  time: string;
  timeField: typeof startTimeField;
  timeLabel: string;
};

const LogisticsLeg = ({
  agents,
  leg,
  assignment,
  listingId,
}: LogisticsAssignmentProps & {
  leg: LogisticsLegName;
}): JSX.Element => {
  const detailsByLeg: Record<LogisticsLegName, LogisticsLegDetails> = {
    end: {
      agentField: endAgentField,
      agentId: assignment.endAgentId,
      agentLabel: t("attendee_form.leg_agent_end"),
      label: t("attendee_form.end_leg"),
      time: assignment.endTime,
      timeField: endTimeField,
      timeLabel: t("attendee_form.leg_time_end"),
    },
    start: {
      agentField: startAgentField,
      agentId: assignment.startAgentId,
      agentLabel: t("attendee_form.leg_agent_start"),
      label: t("attendee_form.start_leg"),
      time: assignment.startTime,
      timeField: startTimeField,
      timeLabel: t("attendee_form.leg_time_start"),
    },
  };
  const details = detailsByLeg[leg];
  return (
    <div class="logistics-leg">
      <span class="logistics-leg-label">{details.label}</span>
      <input
        aria-label={details.timeLabel}
        name={details.timeField(listingId)}
        type="time"
        value={details.time}
      />
      <select
        aria-label={details.agentLabel}
        class="logistics-leg-agent"
        name={details.agentField(listingId)}
      >
        <option selected={details.agentId === null} value="">
          {t("attendee_form.agent_none")}
        </option>
        {agents.map((agent) => (
          <option selected={agent.id === details.agentId} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  );
};

const LogisticsLegPair = ({
  agents,
  assignment,
  listingId,
}: LogisticsAssignmentProps): JSX.Element => (
  <>
    <LogisticsLeg
      agents={agents}
      assignment={assignment}
      leg="start"
      listingId={listingId}
    />
    <LogisticsLeg
      agents={agents}
      assignment={assignment}
      leg="end"
      listingId={listingId}
    />
  </>
);

/** Shared and per-listing logistics agent and time controls. */
export const LogisticsSection = ({
  logistics,
}: {
  logistics: AttendeeLogisticsData | undefined;
}): JSX.Element | null => {
  if (!logistics) return null;
  return (
    <fieldset class="logistics-agents listing-section">
      <legend>{t("attendee_form.logistics_heading")}</legend>
      <label class="split-agents">
        <input
          checked={logistics.split}
          class="split-agents-toggle"
          name={SPLIT_AGENTS_FIELD}
          type="checkbox"
          value="1"
        />
        {t("attendee_form.split_agents")}
      </label>
      <div class="logistics-single">
        <LogisticsLegPair
          agents={logistics.agents}
          assignment={logistics.single}
        />
      </div>
      <div class="logistics-split">
        {logistics.lines.map((line) => (
          <fieldset class="logistics-line">
            <legend>{line.name}</legend>
            <LogisticsLegPair
              agents={logistics.agents}
              assignment={line.assignment}
              listingId={line.listingId}
            />
          </fieldset>
        ))}
      </div>
    </fieldset>
  );
};
