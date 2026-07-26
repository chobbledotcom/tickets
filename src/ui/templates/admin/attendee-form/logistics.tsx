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

const LogisticsLeg = ({
  agents,
  leg,
  assignment,
  listingId,
}: LogisticsAssignmentProps & {
  leg: "start" | "end";
}): JSX.Element => {
  const isStart = leg === "start";
  const label = isStart
    ? t("attendee_form.start_leg")
    : t("attendee_form.end_leg");
  const time = isStart ? assignment.startTime : assignment.endTime;
  const agentId = isStart ? assignment.startAgentId : assignment.endAgentId;
  return (
    <div class="logistics-leg">
      <span class="logistics-leg-label">{label}</span>
      <input
        aria-label={
          isStart
            ? t("attendee_form.leg_time_start")
            : t("attendee_form.leg_time_end")
        }
        name={(isStart ? startTimeField : endTimeField)(listingId)}
        type="time"
        value={time}
      />
      <select
        aria-label={
          isStart
            ? t("attendee_form.leg_agent_start")
            : t("attendee_form.leg_agent_end")
        }
        class="logistics-leg-agent"
        name={(isStart ? startAgentField : endAgentField)(listingId)}
      >
        <option selected={agentId === null} value="">
          {t("attendee_form.agent_none")}
        </option>
        {agents.map((agent) => (
          <option selected={agent.id === agentId} value={agent.id}>
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
