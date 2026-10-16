"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  deleteTemplate,
  renameTemplate,
  setTemplateShare,
  type DashboardRequestError,
} from "@/dashboard/api";
import { TEMPLATE_NAME_MAX, templateNameSchema } from "@/dashboard/schema";
import type { DashboardKind, WidgetType } from "@/dashboard/widgets";
import { isolate } from "@/invitations/format";

import { useFailureMessage } from "./use-failure-message";
import { useWidgetLabels } from "./use-widget-labels";

export interface ManagedTemplate {
  readonly id: string;
  readonly name: string;
  readonly kind: DashboardKind;
  readonly widgets: readonly WidgetType[];
  readonly isMine: boolean;
  /** Homes it is shared into, among the viewer's Homes. */
  readonly sharedHomeIds: readonly string[];
}

export interface TemplateHome {
  readonly id: string;
  readonly name: string;
  /** May edit this Home's dashboard: may share Home templates into it and stop any share there. */
  readonly canEditDashboard: boolean;
}

type Action =
  | { readonly kind: "rename"; readonly id: string; readonly name: string }
  | {
      readonly kind: "share";
      readonly id: string;
      readonly homeId: string;
      readonly shared: boolean;
    }
  | { readonly kind: "delete"; readonly id: string; readonly name: string };

type Notice =
  | { readonly kind: "renamed" }
  | { readonly kind: "shared" | "unshared"; readonly home: string }
  | { readonly kind: "deleted"; readonly name: string };

/**
 * The person's dashboard templates (S17): rename, share into Homes (spec: templates are private
 * until shared, and shared into a Home by its members), stop sharing, and delete to the trash.
 * The database decides every action again; boxes for Homes that cannot take a template are
 * disabled with the reason, never hidden.
 */
export function TemplateManager({
  templates,
  homes,
}: {
  readonly templates: readonly ManagedTemplate[];
  readonly homes: readonly TemplateHome[];
}) {
  const t = useTranslations("DashboardTemplates");
  const router = useRouter();
  const hydrated = useHydrated();
  const failureMessage = useFailureMessage();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleting, setDeleting] = useState<ManagedTemplate | null>(null);
  // A share box shows the requested state while the request runs and the page refreshes, and goes
  // back if the request fails.
  const [shareOverrides, setShareOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const shareKey = (id: string, homeId: string) => `${id}:${homeId}`;
  const homeName = (id: string) => homes.find((home) => home.id === id)?.name ?? "";

  const mutation = useMutation<unknown, DashboardRequestError, Action>({
    mutationFn: (action) => {
      switch (action.kind) {
        case "rename":
          return renameTemplate(action.id, action.name);
        case "share":
          return setTemplateShare(action.id, action.homeId, action.shared);
        case "delete":
          return deleteTemplate(action.id);
      }
    },
    onSuccess: (_, action) => {
      setNotice(
        action.kind === "rename"
          ? { kind: "renamed" }
          : action.kind === "delete"
            ? { kind: "deleted", name: action.name }
            : { kind: action.shared ? "shared" : "unshared", home: homeName(action.homeId) },
      );
      router.refresh();
    },
    onError: (_, action) => {
      if (action.kind === "share") {
        setShareOverrides(({ [shareKey(action.id, action.homeId)]: _dropped, ...rest }) => rest);
      }
      router.refresh();
    },
  });

  const mine = templates.filter((template) => template.isMine);
  const shared = templates.filter((template) => !template.isMine);
  const busy = !hydrated || mutation.isPending;

  return (
    <div className="flex flex-col gap-6">
      {mutation.isError ? (
        <FormAlert tone="error" announce>
          {failureMessage(mutation.error.failure)}
        </FormAlert>
      ) : null}
      {notice ? (
        <FormAlert tone="success" announce>
          {notice.kind === "renamed" ? t("renamedNotice") : null}
          {notice.kind === "shared" ? t("sharedNotice", { home: isolate(notice.home) }) : null}
          {notice.kind === "unshared" ? t("unsharedNotice", { home: isolate(notice.home) }) : null}
          {notice.kind === "deleted" ? (
            <>
              {t("deletedNotice", { name: isolate(notice.name) })}{" "}
              <Link href="/settings/trash" className="font-medium text-accent-fg underline">
                {t("openTrash")}
              </Link>
            </>
          ) : null}
        </FormAlert>
      ) : null}

      <section aria-labelledby="templates-mine" className="flex flex-col gap-4">
        <h2 id="templates-mine" className="text-section-title font-semibold text-fg">
          {t("mineTitle")}
        </h2>
        {mine.length === 0 ? (
          <EmptyState title={t("mineEmptyTitle")} description={t("mineEmpty")} />
        ) : (
          <ul className="flex flex-col gap-4">
            {mine.map((template) => (
              <li key={template.id}>
                <OwnTemplate
                  template={template}
                  homes={homes}
                  busy={busy}
                  onRename={(name) => {
                    mutation.mutate({ kind: "rename", id: template.id, name });
                  }}
                  isShared={(homeId) =>
                    shareOverrides[shareKey(template.id, homeId)] ??
                    template.sharedHomeIds.includes(homeId)
                  }
                  onShare={(homeId, value) => {
                    setShareOverrides((current) => ({
                      ...current,
                      [shareKey(template.id, homeId)]: value,
                    }));
                    mutation.mutate({ kind: "share", id: template.id, homeId, shared: value });
                  }}
                  onDelete={() => {
                    setDeleting(template);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="templates-shared" className="flex flex-col gap-4">
        <h2 id="templates-shared" className="text-section-title font-semibold text-fg">
          {t("sharedTitle")}
        </h2>
        {shared.length === 0 ? (
          <EmptyState title={t("sharedEmptyTitle")} description={t("sharedEmpty")} />
        ) : (
          <ul className="flex flex-col gap-4">
            {shared.map((template) => (
              <li key={template.id}>
                <SharedTemplate
                  template={template}
                  homes={homes}
                  busy={busy}
                  onUnshare={(homeId) => {
                    mutation.mutate({ kind: "share", id: template.id, homeId, shared: false });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        title={deleting ? t("deleteTitle", { name: isolate(deleting.name) }) : ""}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  mutation.mutate({ kind: "delete", id: deleting.id, name: deleting.name });
                }
                setDeleting(null);
              }}
            >
              {t("deleteAction")}
            </Button>
          </>
        }
      >
        <p className="text-body">{t("deleteDescription")}</p>
      </Dialog>
    </div>
  );
}

function TemplateSummary({ template }: { readonly template: ManagedTemplate }) {
  const t = useTranslations("DashboardTemplates");
  const labels = useWidgetLabels();
  return (
    <>
      <p className="text-helper text-fg-muted">
        {template.kind === "personal" ? t("kindPersonal") : t("kindHome")}
      </p>
      <p className="text-body text-fg-muted">
        {template.widgets.length === 0
          ? t("noWidgets")
          : t("contains", { widgets: template.widgets.map(labels.name).join(", ") })}
      </p>
    </>
  );
}

function OwnTemplate({
  template,
  homes,
  busy,
  onRename,
  isShared: sharedInto,
  onShare,
  onDelete,
}: {
  readonly template: ManagedTemplate;
  readonly homes: readonly TemplateHome[];
  readonly busy: boolean;
  readonly onRename: (name: string) => void;
  readonly isShared: (homeId: string) => boolean;
  readonly onShare: (homeId: string, shared: boolean) => void;
  readonly onDelete: () => void;
}) {
  const t = useTranslations("DashboardTemplates");
  const headingId = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(template.name);
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 text-fg shadow-card"
      data-testid="template"
    >
      <h3 id={headingId} className="text-body font-semibold break-words">
        {template.name}
      </h3>
      <TemplateSummary template={template} />

      {renaming ? (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = templateNameSchema.safeParse(name);
            if (!parsed.success) {
              setError(t("nameInvalid"));
              return;
            }
            setError(undefined);
            setRenaming(false);
            onRename(parsed.data);
          }}
        >
          <TextField
            label={t("nameLabel")}
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            error={error}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("saveName")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setRenaming(false);
                setName(template.name);
                setError(undefined);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium">{t("shareLegend")}</legend>
        {homes.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("shareNoHomes")}</p>
        ) : (
          homes.map((home) => {
            const eligible = template.kind === "personal" || home.canEditDashboard;
            const isShared = sharedInto(home.id);
            return (
              <Checkbox
                key={home.id}
                label={home.name}
                {...(eligible ? {} : { description: t("shareNotEligible") })}
                checked={isShared}
                // A share can always be stopped, even where a new one would not be allowed.
                disabled={busy || (!eligible && !isShared)}
                onChange={(event) => {
                  onShare(home.id, event.currentTarget.checked);
                }}
              />
            );
          })
        )}
        <p className="text-helper text-fg-muted">
          {template.kind === "personal" ? t("shareHintPersonal") : t("shareHintHome")}
        </p>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        {renaming ? null : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setRenaming(true);
            }}
          >
            {t("rename")}
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
          {t("delete")}
        </Button>
      </div>
    </article>
  );
}

function SharedTemplate({
  template,
  homes,
  busy,
  onUnshare,
}: {
  readonly template: ManagedTemplate;
  readonly homes: readonly TemplateHome[];
  readonly busy: boolean;
  readonly onUnshare: (homeId: string) => void;
}) {
  const t = useTranslations("DashboardTemplates");
  const headingId = useId();
  const sharedInto = homes.filter((home) => template.sharedHomeIds.includes(home.id));
  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 text-fg shadow-card"
      data-testid="shared-template"
    >
      <h3 id={headingId} className="text-body font-semibold break-words">
        {template.name}
      </h3>
      <TemplateSummary template={template} />
      <ul className="flex flex-col gap-2">
        {sharedInto.map((home) => (
          <li key={home.id} className="flex flex-wrap items-center gap-3">
            <span className="text-body">{t("sharedInto", { home: isolate(home.name) })}</span>
            {home.canEditDashboard ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  onUnshare(home.id);
                }}
              >
                {t("stopSharing")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-helper text-fg-muted">
        {template.kind === "personal" ? t("applyHintPersonal") : t("applyHintHome")}
      </p>
    </article>
  );
}
