"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { choresPath } from "@/chores/format";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";
import {
  VACATION_DECISIONS_ENDPOINT,
  type DecisionKind,
  type PlannedDate,
  type ReviewItem,
} from "@/vacations/api";

import { ChangeDialog } from "./change-dialog";

type Formats = Pick<DateTimeFormats, "dateFormat">;

/**
 * The affected chores of a vacation or absence (S22): each occurrence with why it is listed, who is
 * assigned and away, and the decision taken; chore managers keep, skip, reassign or (one-off chores
 * of a vacation) reschedule each once. Protected work is listed, never changed. Planned dates of
 * recurring chores not created yet are marked Planned.
 */
export function ReviewList({
  homeId,
  source,
  items,
  planned,
  canDecide,
  today,
  members,
  formats,
}: {
  readonly homeId: string;
  readonly source: { readonly kind: "vacation" | "absence"; readonly id: string };
  readonly items: readonly ReviewItem[];
  readonly planned: readonly PlannedDate[];
  readonly canDecide: boolean;
  readonly today: string;
  readonly members: readonly MemberOption[];
  readonly formats: Formats;
}) {
  const t = useTranslations("Vacations");
  const texts = useChoreTexts(memberNames(members));
  const people = (ids: readonly (string | null)[]) =>
    ids.length === 0 ? t("nobody") : ids.map((id) => texts.member(id)).join(", ");
  const base = choresPath(homeId);
  if (items.length === 0 && planned.length === 0) {
    return <p className="text-body text-fg-muted">{t("reviewEmpty")}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {items.length > 0 ? (
        <ul
          className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
          data-testid="vacation-review"
        >
          {items.map((item) => (
            <li
              key={item.occurrenceId}
              className="flex flex-col gap-1 p-4"
              data-testid="vacation-review-item"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`${base}/${item.occurrenceId}`}
                  className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                >
                  <bdi>{item.title}</bdi>
                </Link>
                <span className="text-helper font-semibold text-fg">
                  {t(`reason_${item.reason}`)}
                </span>
              </div>
              <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                <span>{t("dueOn", { date: formatTaskDate(item.dueDate, formats) })}</span>
                <span>{t("assignedTo", { names: people(item.assignees) })}</span>
                {item.away.length > 0 ? (
                  <span>{t("awayNames", { names: people(item.away) })}</span>
                ) : null}
                {item.claimed ? <span>{t("claimed")}</span> : null}
                {item.protected ? (
                  <span className="font-semibold text-fg">{t("protected")}</span>
                ) : null}
              </p>
              {item.decision ? (
                <p className="text-helper text-fg" data-testid="vacation-review-decision">
                  {t(`decided_${item.decision.decision}`, {
                    person: texts.person(item.decision.by),
                    to: texts.member(item.decision.to),
                    date: item.decision.newDate
                      ? formatTaskDate(item.decision.newDate, formats)
                      : "",
                  })}
                </p>
              ) : canDecide && !item.protected && item.status === "open" ? (
                <DecisionActions
                  source={source}
                  item={item}
                  today={today}
                  members={members}
                  formats={formats}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {planned.length > 0 ? (
        <section aria-labelledby={`planned-${source.id}`} className="flex flex-col gap-2">
          <h3 id={`planned-${source.id}`} className="text-body font-semibold text-fg">
            {t("plannedHeading")}
          </h3>
          <ul className="ms-5 list-disc text-body text-fg" data-testid="vacation-planned">
            {planned.map((date) => (
              <li key={`${date.choreId}:${date.date}:${date.member ?? ""}`}>
                <bdi>{date.title}</bdi>
                {", "}
                {formatTaskDate(date.date, formats)}
                {": "}
                {t("plannedLine", { name: texts.member(date.member) })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function DecisionActions({
  source,
  item,
  today,
  members,
  formats,
}: {
  readonly source: { readonly kind: "vacation" | "absence"; readonly id: string };
  readonly item: ReviewItem;
  readonly today: string;
  readonly members: readonly MemberOption[];
  readonly formats: Formats;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const texts = useChoreTexts(names);
  const [memberId, setMemberId] = useState("");
  const [dueDate, setDueDate] = useState(item.dueDate);
  const [confirmAway, setConfirmAway] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const common = {
    scope: `chore-occurrence:${item.occurrenceId}`,
    url: VACATION_DECISIONS_ENDPOINT,
    method: "POST" as const,
    names,
    formats,
    previewed: false,
    // A decision has no preview: the body is the decision.
    withDryRun: false,
  };
  const body = (decision: DecisionKind, extra: Record<string, unknown> = {}) => ({
    sourceKind: source.kind,
    sourceId: source.id,
    occurrenceId: item.occurrenceId,
    expectedRevision: item.revision,
    decision,
    ...extra,
  });
  return (
    <HydrationGate>
      <div className="flex flex-wrap gap-2 pt-1">
        {item.assignees.length > 0 ? (
          <ChangeDialog
            {...common}
            label={t("keep")}
            ariaLabel={t("keepNamed", { title: item.title })}
            title={t("keepTitle")}
            description={t("keepBody", { title: item.title })}
            confirmLabel={t("keep")}
            announcement={t("announceDecided")}
            build={() => body("keep")}
            testId="decision-keep"
          />
        ) : null}
        <ChangeDialog
          {...common}
          label={t("reassign")}
          ariaLabel={t("reassignNamed", { title: item.title })}
          title={t("reassignTitle")}
          description={t("reassignBody", { title: item.title })}
          confirmLabel={t("reassign")}
          announcement={t("announceDecided")}
          onOpen={() => {
            setMemberId("");
            setConfirmAway(false);
            setError(undefined);
          }}
          fields={
            <>
              <SelectField
                label={t("fieldMember")}
                options={[
                  { value: "", label: t("pickMember") },
                  ...members.map((member) => ({
                    value: member.id,
                    label: member.isSelf ? t("you") : texts.member(member.id),
                  })),
                ]}
                value={memberId}
                onChange={(event) => {
                  setMemberId(event.target.value);
                }}
              />
              <label className="flex items-center gap-2 text-body text-fg">
                <input
                  type="checkbox"
                  checked={confirmAway}
                  onChange={(event) => {
                    setConfirmAway(event.target.checked);
                  }}
                />
                {t("confirmAwayLabel")}
              </label>
              {error ? (
                <p className="text-helper text-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          }
          build={() => {
            if (memberId === "") {
              setError(t("errorMemberRequired"));
              return null;
            }
            setError(undefined);
            return body("reassign", { memberId, ...(confirmAway ? { confirmAway: true } : {}) });
          }}
          testId="decision-reassign"
        />
        {source.kind === "vacation" && item.kind === "one_off" ? (
          <ChangeDialog
            {...common}
            label={t("reschedule")}
            ariaLabel={t("rescheduleNamed", { title: item.title })}
            title={t("rescheduleTitle")}
            description={t("rescheduleBody", { title: item.title })}
            confirmLabel={t("reschedule")}
            announcement={t("announceDecided")}
            onOpen={() => {
              setDueDate(item.dueDate < today ? today : item.dueDate);
            }}
            fields={
              <TextField
                type="date"
                label={t("fieldNewDueDate")}
                min={today}
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                }}
              />
            }
            build={() => (dueDate === "" ? null : body("reschedule", { dueDate }))}
            testId="decision-reschedule"
          />
        ) : null}
        <ChangeDialog
          {...common}
          variant="destructive"
          label={t("skip")}
          ariaLabel={t("skipNamed", { title: item.title })}
          title={t("skipTitle")}
          description={t("skipBody", { title: item.title })}
          confirmLabel={t("skip")}
          announcement={t("announceDecided")}
          build={() => body("skip")}
          testId="decision-skip"
        />
      </div>
    </HydrationGate>
  );
}
