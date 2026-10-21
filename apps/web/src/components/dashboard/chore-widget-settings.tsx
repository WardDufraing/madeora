"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { SelectField } from "@/components/ui/select-field";
import {
  choreWidgetCounts,
  choreWidgetRanges,
  choreWidgetStates,
  type WidgetConfigs,
} from "@/dashboard/widgets";
import { sendTaskRequest, TASKS_ENDPOINT, type TaskRequestError } from "@/tasks/api";
import type { TaskWidgetOptions } from "@/tasks/widget-data";

import { taskOptionsKey } from "./task-widget-settings";

const stateKey = {
  outstanding: "choreStateOutstanding",
  overdue: "choreStateOverdue",
  pending_approval: "choreStatePending",
  rework: "choreStateRework",
  completed: "choreStateCompleted",
} as const;
const rangeKey = {
  any: "rangeAny",
  today: "rangeToday",
  next_7_days: "rangeNext7",
  past_7_days: "rangePast7",
} as const;

type ListConfig = WidgetConfigs["my-chores"] | WidgetConfigs["home-chores"];

function CountField({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (count: (typeof choreWidgetCounts)[number]) => void;
}) {
  const t = useTranslations("ChoreWidgets");
  return (
    <SelectField
      label={t("settingCount")}
      value={String(value)}
      options={choreWidgetCounts.map((count) => ({
        value: String(count),
        label: t("settingCountOption", { count }),
      }))}
      onChange={(event) => {
        const count = choreWidgetCounts.find((c) => String(c) === event.currentTarget.value);
        if (count) onChange(count);
      }}
    />
  );
}

/** The members of the widget's Home for All Home Chores (the same read as the task widgets'). */
function MemberField({
  homeId,
  config,
  onChange,
}: {
  readonly homeId: string;
  readonly config: WidgetConfigs["home-chores"];
  readonly onChange: (config: WidgetConfigs["home-chores"]) => void;
}) {
  const t = useTranslations("ChoreWidgets");
  const options = useQuery<TaskWidgetOptions, TaskRequestError>({
    queryKey: taskOptionsKey(homeId),
    queryFn: () =>
      sendTaskRequest<TaskWidgetOptions>(
        "GET",
        `${TASKS_ENDPOINT}/options?homeId=${encodeURIComponent(homeId)}`,
      ),
    retry: false,
  });
  if (options.isPending) return <p className="text-helper text-fg-muted">{t("settingsLoading")}</p>;
  if (options.error) {
    return (
      <FormAlert tone="error" announce>
        {t("settingsFailed")}
      </FormAlert>
    );
  }
  const { members } = options.data;
  const memberMissing =
    config.assignee === "member" &&
    (config.memberId === null || !members.some((member) => member.id === config.memberId));
  return (
    <SelectField
      label={t("settingAssignee")}
      value={
        config.assignee === "member"
          ? memberMissing
            ? "missing"
            : (config.memberId ?? "missing")
          : config.assignee
      }
      options={[
        { value: "any", label: t("filterEveryone") },
        { value: "unassigned", label: t("filterUnassigned") },
        ...(memberMissing ? [{ value: "missing", label: t("settingMemberMissing") }] : []),
        ...members.map((member) => ({
          value: member.id,
          label: member.isSelf ? t("settingMe") : (member.name ?? t("settingUnnamed")),
        })),
      ]}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (value === "missing") return;
        if (value === "any" || value === "unassigned") {
          onChange({ ...config, assignee: value, memberId: null });
        } else {
          onChange({ ...config, assignee: "member", memberId: value });
        }
      }}
    />
  );
}

/**
 * A chore widget's settings (S20): for My Chores and All Home Chores the state, a date range
 * relative to the Home's today, whose (All Home Chores) and how many; for Pending Approvals how
 * many. The server checks every value again on save and render.
 */
export function ChoreWidgetSettings(
  props:
    | {
        readonly type: "my-chores";
        readonly config: WidgetConfigs["my-chores"];
        readonly homeId: string | null;
        readonly onChange: (config: WidgetConfigs["my-chores"]) => void;
      }
    | {
        readonly type: "home-chores";
        readonly config: WidgetConfigs["home-chores"];
        readonly homeId: string | null;
        readonly onChange: (config: WidgetConfigs["home-chores"]) => void;
      }
    | {
        readonly type: "chore-approvals";
        readonly config: WidgetConfigs["chore-approvals"];
        readonly homeId: string | null;
        readonly onChange: (config: WidgetConfigs["chore-approvals"]) => void;
      },
) {
  const t = useTranslations("ChoreWidgets");
  if (props.type === "chore-approvals") {
    return (
      <div className="flex flex-col gap-4" data-testid="chore-widget-settings">
        <CountField
          value={props.config.count}
          onChange={(count) => {
            props.onChange({ ...props.config, count });
          }}
        />
      </div>
    );
  }
  const config: ListConfig = props.config;
  const set = (change: Partial<ListConfig>) => {
    if (props.type === "my-chores") props.onChange({ ...props.config, ...change });
    else props.onChange({ ...props.config, ...change });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="chore-widget-settings">
      <SelectField
        label={t("settingState")}
        value={config.state}
        options={choreWidgetStates.map((value) => ({ value, label: t(stateKey[value]) }))}
        onChange={(event) => {
          const value = choreWidgetStates.find((v) => v === event.currentTarget.value);
          if (value) set({ state: value });
        }}
      />
      <SelectField
        label={t("settingRange")}
        description={t("settingRangeHelp")}
        value={config.range}
        options={choreWidgetRanges.map((value) => ({ value, label: t(rangeKey[value]) }))}
        onChange={(event) => {
          const value = choreWidgetRanges.find((v) => v === event.currentTarget.value);
          if (value) set({ range: value });
        }}
      />
      {props.type === "home-chores" && props.homeId ? (
        <MemberField homeId={props.homeId} config={props.config} onChange={props.onChange} />
      ) : null}
      <CountField
        value={config.count}
        onChange={(count) => {
          set({ count });
        }}
      />
    </div>
  );
}
