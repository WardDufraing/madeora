import { getServerEnv } from "@madeora/config/env/server";
import {
  CheckIcon,
  CloseIcon,
  ErrorIcon,
  InfoIcon,
  SpinnerIcon,
  SuccessIcon,
  WarningIcon,
} from "@madeora/icons";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";

import { InteractiveDemo } from "./interactive-demo";

export const metadata: Metadata = {
  title: "Component preview",
  robots: { index: false, follow: false },
};

const icons = [
  ["Check", CheckIcon],
  ["Close", CloseIcon],
  ["Info", InfoIcon],
  ["Success", SuccessIcon],
  ["Warning", WarningIcon],
  ["Error", ErrorIcon],
  ["Spinner", SpinnerIcon],
] as const;

/**
 * Development-only preview of the base components, for visual review and the browser
 * accessibility tests. Not served in production. Text here is fixed English sample copy;
 * product screens get their text from next-intl (S05).
 */
export default async function ComponentPreviewPage() {
  // Decide per request, so a build made for another environment cannot serve it in production.
  await connection();
  if (getServerEnv().APP_ENV === "production") notFound();

  return (
    // Fixed English sample copy, whatever the interface language.
    <main lang="en" className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold">Component preview</h1>
        <p className="text-body text-fg-muted">
          Madeora base components with the current theme and accent tokens.
        </p>
      </header>

      <Card title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button size="sm">Small</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Card>

      <div className="grid gap-8 md:grid-cols-2">
        <Card title="Text fields">
          <div className="flex flex-col gap-5">
            <TextField
              label="Display name"
              name="displayName"
              description="Shown to people in your Homes."
            />
            <TextField
              label="Email"
              name="email"
              type="email"
              required
              defaultValue="not-an-email"
              error="Enter a valid email address."
            />
            <TextField label="Disabled" name="disabled" disabled defaultValue="Can't change this" />
          </div>
        </Card>

        <Card title="Checkboxes">
          <div className="flex flex-col gap-4">
            <Checkbox label="Unchecked" name="unchecked" />
            <Checkbox label="Checked" name="checked" defaultChecked />
            <Checkbox
              label="With a description"
              name="described"
              description="Helper text under the label."
            />
            <Checkbox label="Needs attention" name="invalid" error="Please confirm this." />
            <Checkbox label="Disabled" name="disabled-checkbox" disabled defaultChecked />
          </div>
        </Card>
      </div>

      <div className="grid gap-8 md:grid-cols-3">
        <Card title="Empty" headingLevel={2}>
          <EmptyState
            title="Nothing here yet"
            description="Items you add appear here."
            action={<Button size="sm">Add item</Button>}
          />
        </Card>
        <Card title="Loading">
          <LoadingState label="Loading items…" />
        </Card>
        <Card title="Error">
          <ErrorState
            title="Couldn't load this"
            description="Check your connection and try again."
            action={
              <Button size="sm" variant="secondary">
                Try again
              </Button>
            }
          />
        </Card>
      </div>

      <Card
        title="Card with an action"
        description="A short description."
        action={
          <a
            href="#icons"
            className="text-helper font-medium text-accent-fg underline-offset-4 hover:underline"
          >
            View all
          </a>
        }
      >
        <p className="text-body">Cards use a solid surface and a subtle border.</p>
      </Card>

      <InteractiveDemo />

      <Card title="Icons">
        <ul id="icons" className="flex flex-wrap gap-6">
          {icons.map(([name, Icon]) => (
            <li key={name} className="flex flex-col items-center gap-2 text-helper text-fg-muted">
              <Icon size="lg" className="text-fg" />
              {name}
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
