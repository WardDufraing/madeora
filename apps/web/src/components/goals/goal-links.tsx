"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { goalLinkStartDate, type GoalLinkRemoval, type GoalLinkStart } from "@madeora/domain/goals";
import type { HabitUnitKind } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import {
  goalLinkEndpoint,
  goalLinksQuery,
  GOAL_LINKS_ENDPOINT,
  sendGoalRequest,
  type GoalLink,
  type GoalLinkCandidates,
  type GoalLinkImpact,
  type GoalLinkResult,
  type GoalLinks,
  type GoalRequestError,
} from "@/goals/api";
import { goalKeys, goalSeriesPath, goalsPath, newId } from "@/goals/format";
import { goalLinkImpactSchema } from "@/goals/shapes";
import { habitsPath } from "@/habits/format";

import { DialogActions, Failure } from "./goal-dialogs";
import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** A goal or series links count toward. */
export type GoalLinkDestination = { readonly goalId: string } | { readonly seriesId: string };

/** The unit the destination counts in, for amounts. */
export interface GoalLinkUnit {
  readonly unit: string | null;
  readonly unitKind: HabitUnitKind | null;
}

/** The impact a refused confirmation carries (a stale preview), when there is one. */
function refusedImpact(error: GoalRequestError | null): GoalLinkImpact | null {
  if (error?.failure !== "stale") return null;
  const parsed = goalLinkImpactSchema.safeParse(error.details.impact);
  return parsed.success ? parsed.data : null;
}

/** The revision a stale answer carries, to confirm what the person now sees. */
function refusedRevision(error: GoalRequestError | null): number | null {
  return error?.failure === "stale" ? (error.details.revision ?? null) : null;
}

function useLinks(target: GoalLinkDestination | { readonly habitId: string }) {
  const [kind, id] =
    "goalId" in target
      ? (["goal", target.goalId] as const)
      : "seriesId" in target
        ? (["series", target.seriesId] as const)
        : (["habit", target.habitId] as const);
  return useQuery<GoalLinks>({
    queryKey: goalKeys.links(kind, id),
    queryFn: () => sendGoalRequest("GET", goalLinksQuery(target)),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** The start choice of a link form: today, a chosen past date, or the habit's beginning. */
function StartFields({
  start,
  date,
  today,
  firstStart,
  onChange,
}: {
  readonly start: GoalLinkStart;
  readonly date: string;
  readonly today: string;
  readonly firstStart: string | null;
  readonly onChange: (start: GoalLinkStart, date: string) => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  return (
    <>
      <SelectField
        label={t("linkStart")}
        description={t("linkStartHint")}
        value={start}
        options={[
          { value: "today", label: t("linkStartToday") },
          { value: "date", label: t("linkStartDate") },
          {
            value: "beginning",
            label: firstStart
              ? t("linkStartBeginningOn", { date: texts.date(firstStart) })
              : t("linkStartBeginning"),
          },
        ]}
        onChange={(event) => {
          onChange(event.target.value as GoalLinkStart, date);
        }}
        data-testid="goal-link-start"
      />
      {start === "date" ? (
        <TextField
          label={t("linkStartDateField")}
          type="date"
          min={firstStart ?? undefined}
          max={today}
          value={date}
          onChange={(event) => {
            onChange(start, event.target.value);
          }}
          data-testid="goal-link-start-date"
        />
      ) : null}
    </>
  );
}

/** What a link change does, in words: the range, the units and each goal's total before and after. */
export function GoalLinkImpactSummary({
  impact,
  unit,
}: {
  readonly impact: GoalLinkImpact;
  readonly unit: GoalLinkUnit;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const amount = (value: number) => texts.amount(value, unit.unit, unit.unitKind);
  const habitUnit = impact.habit?.unit ?? null;
  const converted =
    habitUnit !== null &&
    unit.unit !== null &&
    (habitUnit !== unit.unit || impact.habit?.unitKind !== unit.unitKind);
  return (
    <div className="flex flex-col gap-2 text-body text-fg" data-testid="goal-link-impact">
      {impact.startsOn && impact.until ? (
        <p>
          {t("linkImpactRange", {
            start: texts.date(impact.startsOn),
            end: texts.date(impact.until),
          })}
        </p>
      ) : null}
      {converted && impact.habit?.unit && impact.habit.unitKind && unit.unit && unit.unitKind ? (
        <p>
          {t("linkImpactUnits", {
            from: texts.numeric.unitLabel(impact.habit.unit, impact.habit.unitKind),
            to: texts.numeric.unitLabel(unit.unit, unit.unitKind),
          })}
        </p>
      ) : null}
      <p data-testid="goal-link-impact-amount">
        {t("linkImpactAmount", {
          before: amount(impact.amountBefore),
          after: amount(impact.amountAfter),
        })}
      </p>
      {impact.uncountedDays > 0 ? (
        <p role="note">{t("linkImpactUncounted", { count: impact.uncountedDays })}</p>
      ) : null}
      <ul className="flex flex-col gap-1" data-testid="goal-link-impact-goals">
        {impact.goals.map((goal) => {
          const name =
            goal.periodStart && goal.periodEnd
              ? texts.period(goal.periodStart, goal.periodEnd)
              : goal.title;
          const progress = (total: number) =>
            goal.target !== null && goal.unit && goal.unitKind
              ? texts.numeric.progress(total, goal.target, goal.unit, goal.unitKind)
              : texts.numeric.number(total);
          return (
            <li key={goal.goalId}>
              <bdi>{name}</bdi>
              {": "}
              {t("linkImpactTotal", {
                before: progress(goal.totalBefore),
                after: progress(goal.totalAfter),
              })}
              {goal.reachedAfter && !goal.reachedBefore ? ` · ${t("linkImpactReaches")}` : ""}
              {goal.reachedBefore && !goal.reachedAfter ? ` · ${t("linkImpactUnreaches")}` : ""}
              {goal.ended ? ` · ${t("linkImpactEnded")}` : ""}
              {goal.achieved ? ` · ${t("linkImpactAchieved")}` : ""}
              {goal.syncable ? "" : ` · ${t("linkImpactArchived")}`}
            </li>
          );
        })}
      </ul>
      <p className="text-helper text-fg-muted">{t("linkImpactNoAchieve")}</p>
    </div>
  );
}

/**
 * Links a numeric habit to a goal or series after a preview (managers of both). The habits offered
 * are the ones the database says the person could link; the preview and every refusal come from it.
 */
export function LinkHabitDialog({
  destination,
  unit,
  onClose,
}: {
  readonly destination: GoalLinkDestination;
  readonly unit: GoalLinkUnit;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const kind = "goalId" in destination ? "goal" : "series";
  const destinationId = "goalId" in destination ? destination.goalId : destination.seriesId;
  const candidates = useQuery<GoalLinkCandidates>({
    queryKey: goalKeys.linkCandidates(kind, destinationId),
    queryFn: () => sendGoalRequest("GET", goalLinksQuery(destination, true)),
  });
  const habits = candidates.data?.habits ?? [];
  const [id] = useState(newId);
  const [habitId, setHabitId] = useState<string>("");
  const [start, setStart] = useState<GoalLinkStart>("today");
  const [date, setDate] = useState("");
  const [preview, setPreview] = useState<{ impact: GoalLinkImpact; revision: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const habit = habits.find((candidate) => candidate.id === habitId) ?? habits[0] ?? null;
  const send = useGoalMutation(
    `goal-link:${destinationId}`,
    (body: object) => sendGoalRequest<GoalLinkResult>("POST", GOAL_LINKS_ENDPOINT, body),
    (result) => {
      if (result.outcome === "preview" && result.impact && result.revision !== undefined) {
        setPreview({ impact: result.impact, revision: result.revision });
      } else {
        onClose();
      }
    },
  );
  const stale = refusedImpact(send.error);
  const shown = stale
    ? { impact: stale, revision: refusedRevision(send.error) ?? preview?.revision ?? 0 }
    : preview;
  const request = () => {
    if (!habit) return null;
    const startsOn = goalLinkStartDate(start, {
      today: habit.today,
      firstStart: habit.firstStart ?? habit.today,
      date: date || null,
    });
    if (startsOn === null) {
      setProblem(t("linkStartInvalid"));
      return null;
    }
    setProblem(null);
    return {
      id,
      habitId: habit.id,
      ...destination,
      start,
      startDate: start === "date" ? date : null,
    };
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("linkTitle")}
      description={t("linkExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = request();
          if (body) send.mutate({ ...body, preview: true });
        }}
        data-testid="goal-link-form"
      >
        {candidates.isPending ? <p className="text-body text-fg-muted">{t("loading")}</p> : null}
        {candidates.isError ? (
          <FormAlert tone="error" announce>
            {t("linkCandidatesFailed")}
          </FormAlert>
        ) : null}
        {candidates.isSuccess && habits.length === 0 ? (
          <p className="text-body text-fg" data-testid="goal-link-none">
            {t("linkNoHabits")}
          </p>
        ) : null}
        {habit ? (
          <>
            <SelectField
              label={t("linkHabit")}
              value={habit.id}
              options={habits.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              onChange={(event) => {
                setHabitId(event.target.value);
                setPreview(null);
              }}
              data-testid="goal-link-habit"
            />
            <StartFields
              start={start}
              date={date}
              today={habit.today}
              firstStart={habit.firstStart}
              onChange={(nextStart, nextDate) => {
                setStart(nextStart);
                setDate(nextDate);
                setPreview(null);
              }}
            />
          </>
        ) : null}
        {problem ? (
          <FormAlert tone="error" announce>
            {problem}
          </FormAlert>
        ) : null}
        {shown ? <GoalLinkImpactSummary impact={shown.impact} unit={unit} /> : null}
        {stale ? (
          <FormAlert tone="info" announce>
            {t("linkStale")}
          </FormAlert>
        ) : null}
        <p className="text-helper text-fg-muted">{t("linkManualWarning")}</p>
        <Failure error={send.error && !stale ? send.error : null} />
        <DialogActions onClose={onClose}>
          {habit ? (
            <Button type="submit" variant="secondary" loading={send.busy && !shown}>
              {t("preview")}
            </Button>
          ) : null}
          {shown && habit ? (
            <Button
              loading={send.busy}
              onClick={() => {
                const body = request();
                if (!body) return;
                send.mutate({
                  ...body,
                  revision: shown.revision,
                  expectedAmount: shown.impact.amountAfter,
                });
              }}
              data-testid="goal-link-save"
            >
              {t("linkConfirm")}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Moves a link's first counted day, after a preview. */
function ChangeStartDialog({
  link,
  unit,
  onClose,
}: {
  readonly link: GoalLink;
  readonly unit: GoalLinkUnit;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const [start, setStart] = useState<GoalLinkStart>("date");
  const [date, setDate] = useState(link.startsOn);
  const [preview, setPreview] = useState<{ impact: GoalLinkImpact; revision: number } | null>(null);
  const send = useGoalMutation(
    `goal-link:${link.id}`,
    (body: object) => sendGoalRequest<GoalLinkResult>("PATCH", goalLinkEndpoint(link.id), body),
    (result) => {
      if (
        (result.outcome === "preview" || result.outcome === "unchanged") &&
        result.impact &&
        result.revision !== undefined
      ) {
        setPreview({ impact: result.impact, revision: result.revision });
      } else {
        onClose();
      }
    },
  );
  const stale = refusedImpact(send.error);
  const shown = stale
    ? { impact: stale, revision: refusedRevision(send.error) ?? preview?.revision ?? 0 }
    : preview;
  const body = () => ({ start, startDate: start === "date" ? date : null });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("linkChangeStartTitle", { habit: link.habit?.name ?? "" })}
      description={t("linkChangeStartExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate({ ...body(), preview: true });
        }}
        data-testid="goal-link-start-form"
      >
        <StartFields
          start={start}
          date={date}
          today={link.habit?.today ?? link.startsOn}
          firstStart={link.habit?.firstStart ?? null}
          onChange={(nextStart, nextDate) => {
            setStart(nextStart);
            setDate(nextDate);
            setPreview(null);
          }}
        />
        {shown ? <GoalLinkImpactSummary impact={shown.impact} unit={unit} /> : null}
        {stale ? (
          <FormAlert tone="info" announce>
            {t("linkStale")}
          </FormAlert>
        ) : null}
        <Failure error={send.error && !stale ? send.error : null} />
        <DialogActions onClose={onClose}>
          <Button type="submit" variant="secondary" loading={send.busy && !shown}>
            {t("preview")}
          </Button>
          {shown && shown.impact.startsOn !== link.startsOn ? (
            <Button
              loading={send.busy}
              onClick={() => {
                send.mutate({
                  ...body(),
                  revision: shown.revision,
                  expectedAmount: shown.impact.amountAfter,
                });
              }}
              data-testid="goal-link-start-save"
            >
              {t("save")}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Removes a link, keeping its amount as a manual adjustment or taking it out, after a preview. */
function UnlinkDialog({
  link,
  unit,
  onClose,
}: {
  readonly link: GoalLink;
  readonly unit: GoalLinkUnit;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const [mode, setMode] = useState<GoalLinkRemoval>("keep");
  const [preview, setPreview] = useState<{ impact: GoalLinkImpact; revision: number } | null>(null);
  const send = useGoalMutation(
    `goal-link:${link.id}`,
    (body: object) =>
      sendGoalRequest<GoalLinkResult>("POST", goalLinkEndpoint(link.id, "unlink"), body),
    (result) => {
      if (result.outcome === "preview" && result.impact && result.revision !== undefined) {
        setPreview({ impact: result.impact, revision: result.revision });
      } else {
        onClose();
      }
    },
  );
  const stale = refusedImpact(send.error);
  const shown = stale
    ? { impact: stale, revision: refusedRevision(send.error) ?? preview?.revision ?? 0 }
    : preview;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("unlinkTitle", { habit: link.habit?.name ?? t("linkHabitDeleted") })}
      description={t("unlinkExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate({ mode, preview: true });
        }}
        data-testid="goal-unlink-form"
      >
        <SelectField
          label={t("unlinkMode")}
          value={mode}
          options={[
            { value: "keep", label: t("unlinkKeep") },
            { value: "remove", label: t("unlinkRemove") },
          ]}
          onChange={(event) => {
            setMode(event.target.value as GoalLinkRemoval);
            setPreview(null);
          }}
          data-testid="goal-unlink-mode"
        />
        <p className="text-helper text-fg-muted">
          {mode === "keep" ? t("unlinkKeepHint") : t("unlinkRemoveHint")}
        </p>
        {shown ? <GoalLinkImpactSummary impact={shown.impact} unit={unit} /> : null}
        {stale ? (
          <FormAlert tone="info" announce>
            {t("linkStale")}
          </FormAlert>
        ) : null}
        <p className="text-helper text-fg-muted">{t("linkManualWarning")}</p>
        <Failure error={send.error && !stale ? send.error : null} />
        <DialogActions onClose={onClose}>
          <Button type="submit" variant="secondary" loading={send.busy && !shown}>
            {t("preview")}
          </Button>
          {shown ? (
            <Button
              variant="destructive"
              loading={send.busy}
              onClick={() => {
                send.mutate({
                  mode,
                  revision: shown.revision,
                  expectedAmount: shown.impact.amountBefore,
                });
              }}
              data-testid="goal-unlink-save"
            >
              {t("unlink")}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  );
}

type LinkDialog =
  { readonly kind: "link" } | { readonly kind: "start" | "unlink"; readonly link: GoalLink };

/**
 * The habits counting toward a goal or series (S30c): each with where it counts from, what it adds,
 * days in a unit that cannot count and a habit that is archived, in the trash or deleted. Managers of
 * both sides link a habit, move a start or unlink. A period shows its series' links read-only.
 */
export function GoalLinksSection({
  target,
  homeId,
  unit,
  canLink,
  readOnly = false,
}: {
  /** Whose links: a goal (a period: its series' links, amounts for the period) or a series. */
  readonly target: GoalLinkDestination;
  readonly homeId: string | null;
  readonly unit: GoalLinkUnit;
  /** The person may link a habit here now (a manager of a measurable, open goal or series). */
  readonly canLink: boolean;
  /** A period: its links are managed on its series. */
  readonly readOnly?: boolean;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const links = useLinks(target);
  const [dialog, setDialog] = useState<LinkDialog | null>(null);
  const close = () => {
    setDialog(null);
  };
  const rows = links.data?.links ?? [];
  if (rows.length === 0 && !canLink) return null;
  return (
    <section aria-labelledby="goal-links-heading" className="flex max-w-xl flex-col gap-2">
      <h2 id="goal-links-heading" className="text-section-title font-semibold">
        {t("linksTitle")}
      </h2>
      {links.isError ? <p className="text-body text-danger">{t("linksFailed")}</p> : null}
      {links.isSuccess && rows.length === 0 ? (
        <p className="text-body text-fg-muted">{t("linksEmpty")}</p>
      ) : null}
      {readOnly && rows.length > 0 ? (
        <p className="text-helper text-fg-muted">{t("linksFromSeries")}</p>
      ) : null}
      <ul className="flex flex-col gap-2" data-testid="goal-links">
        {rows.map((link) => (
          <li key={link.id} className="flex flex-col gap-1" data-testid="goal-link">
            <p className="text-body text-fg">
              {link.habit ? (
                <Link
                  href={habitsPath(homeId, link.habit.id)}
                  className="font-medium text-accent-fg underline"
                >
                  <bdi>{link.habit.name}</bdi>
                </Link>
              ) : (
                <span className="font-medium">{t("linkHabitDeleted")}</span>
              )}
              {" · "}
              {t("linkFrom", { date: texts.date(link.startsOn) })}
              {" · "}
              <span data-testid="goal-link-amount">
                {t("linkAmount", {
                  amount: texts.amount(link.amount, unit.unit, unit.unitKind),
                })}
              </span>
            </p>
            {link.source !== "active" ? (
              <p className="text-helper text-fg-muted" data-testid="goal-link-source">
                {t(
                  link.source === "archived"
                    ? "linkSourceArchived"
                    : link.source === "trash"
                      ? "linkSourceTrash"
                      : "linkSourceDeleted",
                )}
              </p>
            ) : null}
            {link.uncountedDays > 0 ? (
              <p className="text-helper text-fg" role="note" data-testid="goal-link-uncounted">
                {t("linkUncounted", { count: link.uncountedDays })}
              </p>
            ) : null}
            {!readOnly && link.actions.manage ? (
              <div className="flex flex-wrap gap-2">
                {link.actions.changeStart ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setDialog({ kind: "start", link });
                    }}
                    data-testid="goal-link-change-start"
                  >
                    {t("linkChangeStart")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDialog({ kind: "unlink", link });
                  }}
                  data-testid="goal-link-unlink"
                >
                  {t("unlink")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canLink && !readOnly ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setDialog({ kind: "link" });
            }}
            data-testid="goal-link-habit-open"
          >
            {t("linkHabitAction")}
          </Button>
        </div>
      ) : null}
      {dialog?.kind === "link" ? (
        <LinkHabitDialog destination={target} unit={unit} onClose={close} />
      ) : null}
      {dialog?.kind === "start" ? (
        <ChangeStartDialog link={dialog.link} unit={unit} onClose={close} />
      ) : null}
      {dialog?.kind === "unlink" ? (
        <UnlinkDialog link={dialog.link} unit={unit} onClose={close} />
      ) : null}
    </section>
  );
}

/** The goals a habit counts toward (S30c), as the person may see them, each linking to its page. */
export function HabitLinkedGoals({
  habitId,
  homeId,
}: {
  readonly habitId: string;
  readonly homeId: string | null;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const links = useLinks({ habitId });
  const rows = links.data?.links ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="habit-linked-goals-heading" className="flex flex-col gap-2">
      <h2 id="habit-linked-goals-heading" className="text-section-title font-semibold">
        {t("linkedGoalsTitle")}
      </h2>
      <ul className="flex flex-col gap-1 text-body text-fg" data-testid="habit-linked-goals">
        {rows.map((link) => (
          <li key={link.id}>
            <Link
              href={
                link.destination.kind === "series"
                  ? goalSeriesPath(homeId, link.destination.id)
                  : goalsPath(homeId, link.destination.id)
              }
              className="text-accent-fg underline"
            >
              <bdi>{link.destination.title}</bdi>
            </Link>
            {link.destination.kind === "series"
              ? ` (${texts.frequency(link.destination.frequency)})`
              : ""}
            {" · "}
            {t("linkFrom", { date: texts.date(link.startsOn) })}
          </li>
        ))}
      </ul>
    </section>
  );
}
