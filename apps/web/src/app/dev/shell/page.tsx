import { getServerEnv } from "@madeora/config/env/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { WidgetFrame } from "@/components/dashboard/dashboard-grid";
import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { PreviewProvider } from "./preview-provider";

export const metadata: Metadata = {
  title: "Shell preview · Madeora",
  robots: { index: false, follow: false },
};

const schedule = [
  ["09:00", "Physiotherapy", "AZ Voorkempen"],
  ["11:00", "Work · Easy Life", "Borsbeek"],
  ["15:00", "Call with Jolien", "Discuss weekend plans"],
  ["19:30", "Dinner", "Pasta with vegetables"],
] as const;

const chores = [
  ["Vacuum living room", true],
  ["Clean bathroom", false],
  ["Take out trash", false],
  ["Water plants", false],
] as const;

const stats = [
  ["Open tasks", "12"],
  ["Done today", "7"],
  ["Habit streak", "9 days"],
] as const;

/**
 * Development-only preview of the signed-in shell with a sample dashboard, so the look of the
 * frame, sidebar and widgets can be reviewed (and screenshotted) in both themes without an
 * account. Not served in production. Fixed English sample copy.
 */
export default async function ShellPreviewPage() {
  await connection();
  if (getServerEnv().APP_ENV === "production") notFound();

  return (
    <PreviewProvider>
      <AppShell sidebar="expanded" homes={[]} unreadNotifications={3}>
        <div lang="en" className="mx-auto w-full max-w-(--md-canvas-max-width)">
          <PageHeader title="Good evening, Sam" />
          <div className="grid grid-cols-1 gap-(--md-space-grid-gap) md:grid-cols-3">
            {stats.map(([label, value]) => (
              <WidgetFrame key={label} widget={{ title: label, unavailable: false }}>
                <p className="text-5xl font-bold tracking-tight">{value}</p>
                <p className="mt-1 text-helper text-fg-muted">This week</p>
              </WidgetFrame>
            ))}
            <WidgetFrame
              widget={{ title: "Today's schedule", unavailable: false }}
              className="md:col-span-2"
            >
              <ul className="flex flex-col gap-4">
                {schedule.map(([time, title, place]) => (
                  <li key={time} className="flex gap-4">
                    <span className="w-12 text-helper text-fg-muted">{time}</span>
                    <span className="flex flex-col">
                      <span className="font-semibold">{title}</span>
                      <span className="text-helper text-fg-muted">{place}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </WidgetFrame>
            <WidgetFrame widget={{ title: "Household chores", unavailable: false }}>
              <ul className="flex flex-col gap-3">
                {chores.map(([label, done]) => (
                  <li key={label}>
                    <Checkbox label={label} defaultChecked={done} />
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex gap-2">
                <Button size="sm">Add chore</Button>
                <Button size="sm" variant="secondary">
                  View all
                </Button>
              </div>
            </WidgetFrame>
          </div>
        </div>
      </AppShell>
    </PreviewProvider>
  );
}
