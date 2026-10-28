import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { addDays, isMealDate } from "@madeora/domain/meals";

import { zonedParts } from "@/chores/format";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { getDateTimeFormats } from "@/invitations/server";
import { readMealPlan } from "@/meals/data";
import { mealsPath, weekOf } from "@/meals/format";
import { getRegionalFormats } from "@/preferences/server";

import { MealCopyWeek } from "./meal-copy-week";
import { MealPlanner } from "./meal-planner";
import { MealPrint } from "./meal-print";
import { MealSettings } from "./meal-settings";
import { MealShoppingTransfer } from "./meal-shopping-transfer";

export type MealsPageKind = "planner" | "settings" | "copy" | "shopping" | "print";

export interface MealsPageProps {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
  readonly kind: MealsPageKind;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

function param(value: string | string[] | undefined): string | null {
  return typeof value === "string" && isMealDate(value) ? value : null;
}

/**
 * A meal-planner page of one context (S27): the planner (week or day), its slots and settings,
 * copy week, the ingredient transfer or the print view. The plan is read with the viewer's own
 * session for the shown dates; a Home the person is not in is not found.
 */
export async function MealsPage({ home, kind, searchParams }: MealsPageProps) {
  const homeId = home?.id ?? null;
  const [t, formats, regional] = await Promise.all([
    getTranslations("Meals"),
    getDateTimeFormats(),
    getRegionalFormats(),
  ]);
  const weekStart = regional.effective.weekStart;
  // "Today" where the plan lives: the Home's timezone, or the person's (the database agrees).
  const today = zonedParts(new Date().toISOString(), home?.timeZone ?? formats.timeZone).date;
  const date = param(searchParams.date) ?? today;
  const day = kind === "planner" && searchParams.view === "day";
  const week = weekOf(date, weekStart);
  const from = day ? date : (week[0] ?? date);
  const to = day ? date : (week[6] ?? date);
  const plan = await readMealPlan(homeId, from, to);
  if (plan.status === "not-found") notFound();
  if (plan.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const context = home ? home.name : t("personalSpace");
  const back =
    kind === "planner" ? null : (
      <p className="mb-2 print:hidden">
        <Link
          href={`${mealsPath(homeId)}?date=${from}`}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToPlanner")}
        </Link>
      </p>
    );
  const titles = {
    planner: t("title"),
    settings: t("settingsTitle"),
    copy: t("copyTitle"),
    shopping: t("transferTitle"),
    print: t("printTitle"),
  } as const;
  return (
    <>
      {back}
      <div className="print:hidden">
        <PageHeader title={titles[kind]} />
      </div>
      {kind === "planner" ? (
        <MealPlanner
          homeId={homeId}
          context={context}
          initialPlan={plan.value}
          view={day ? "day" : "week"}
          date={date}
          weekStart={weekStart}
        />
      ) : kind === "settings" ? (
        <MealSettings homeId={homeId} context={context} plan={plan.value} />
      ) : kind === "copy" ? (
        <MealCopyWeek
          homeId={homeId}
          source={from}
          destination={addDays(from, 7)}
          weekStart={weekStart}
        />
      ) : kind === "shopping" ? (
        <MealShoppingTransfer homeId={homeId} from={from} to={to} />
      ) : (
        <MealPrint homeId={homeId} context={context} plan={plan.value} />
      )}
    </>
  );
}
