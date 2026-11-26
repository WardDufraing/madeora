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
  duplicateTemplate,
  renameTemplate,
  setTemplateShare,
  type DashboardRequestError,
} from "@/dashboard/api";
import { copyName, type LayoutPreview } from "@/dashboard/preview";
import { TEMPLATE_NAME_MAX, templateNameSchema } from "@/dashboard/schema";
import type { DashboardKind, WidgetType } from "@/dashboard/widgets";
import { isolate } from "@/invitations/format";

import { LayoutPreviewView } from "./layout-preview";
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
  /** Its arrangement, for the preview (UX2c). */
  readonly preview: LayoutPreview;
}

/** How many Home widgets a duplicate left out (the duplicate answer's `dropped`). */
function droppedOf(result: unknown): number {
  return result &&
    typeof result === "object" &&
    "dropped" in result &&
    typeof result.dropped === "number"
    ? result.dropped
    : 0;
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
  | { readonly kind: "delete"; readonly id: string; readonly name: string }
  | { readonly kind: "duplicate"; readonly id: string; readonly name: string };

type Notice =
  | { readonly kind: "renamed" }
  | { readonly kind: "shared" | "unshared"; readonly home: string }
  | { readonly kind: "deleted"; readonly name: string }
  | { readonly kind: "duplicated"; readonly name: string; readonly dropped: number };

/**
 * The person's dashboard templates (S17): rename, share into Homes (spec: templates are private
 * until shared, and shared into a Home by its members), stop sharing, and delete to the trash. With
 * UX2c (redesign decision 31, layout presets) every template also has a preview of its arrangement
 * and can be duplicated: own ones and shared ones alike become a new private template of the
 * person's own, under a name none of their templates uses.
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
        case "duplicate":
          return duplicateTemplate(action.id, action.name);
        case "rename":
          return renameTemplate(action.id, action.name);
        case "share":
          return setTemplateShare(action.id, action.homeId, action.shared);
        case "delete":
          return deleteTemplate(action.id);
      }
    },
    onSuccess: (result, action) => {
      setNotice(
        action.kind === "rename"
          ? { kind: "renamed" }
          : action.kind === "delete"
            ? { kind: "deleted", name: action.name }
            : action.kind === "duplicate"
              ? { kind: "duplicated", name: action.name, dropped: droppedOf(result) }
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
  const ownNames = mine.map((template) => template.name);

  /** Decision 31: a copy gets a name none of the person's templates uses. */
  function duplicate(template: ManagedTemplate) {
    const name = copyName(
      template.name,
      ownNames,
      (base, n) =>
        n === 1 ? t("copyName", { name: base }) : t("copyNameNumbered", { name: base, n }),
      TEMPLATE_NAME_MAX,
    );
    mutation.mutate({ kind: "duplicate", id: template.id, name });
  }

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
          {notice.kind === "duplicated" ? (
            <>
              {t("duplicatedNotice", { name: isolate(notice.name) })}
              {notice.dropped > 0 ? ` ${t("duplicatedDropped", { count: notice.dropped })}` : ""}
            </>
          ) : null}
          {notice.kind === "deleted" ? (
            <>
              {t("deletedNotice", { name: isolate(notice.name) })}{" "}
              <Link href="/settings/trash" className="link-inline">
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
                  takenNames={ownNames.filter((name) => name !== template.name)}
                  onRename={(name) => {
                    mutation.mutate({ kind: "rename", id: template.id, name });
                  }}
                  onDuplicate={() => {
                    duplicate(template);
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
                  onDuplicate={() => {
                    duplicate(template);
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
  const previewId = useId();
  const [previewing, setPreviewing] = useState(false);
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
      {template.widgets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={previewing}
              aria-controls={previewId}
              onClick={() => {
                setPreviewing((value) => !value);
              }}
              data-testid="template-preview"
            >
              {previewing ? t("hidePreview") : t("preview")}
            </Button>
          </div>
          <div id={previewId} hidden={!previewing}>
            {previewing ? (
              <LayoutPreviewView
                preview={template.preview}
                label={t("previewLabel", { name: template.name })}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function OwnTemplate({
  template,
  homes,
  busy,
  takenNames,
  onRename,
  onDuplicate,
  isShared: sharedInto,
  onShare,
  onDelete,
}: {
  readonly template: ManagedTemplate;
  readonly homes: readonly TemplateHome[];
  readonly busy: boolean;
  /** Names of the person's other templates: a rename may not reuse one. */
  readonly takenNames: readonly string[];
  readonly onRename: (name: string) => void;
  readonly onDuplicate: () => void;
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
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 text-fg shadow-raised"
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
            const lower = parsed.data.toLocaleLowerCase();
            if (takenNames.some((taken) => taken.trim().toLocaleLowerCase() === lower)) {
              setError(t("nameTaken"));
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
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onDuplicate}
          data-testid="template-duplicate"
        >
          {t("duplicate")}
        </Button>
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
  onDuplicate,
}: {
  readonly template: ManagedTemplate;
  readonly homes: readonly TemplateHome[];
  readonly busy: boolean;
  readonly onUnshare: (homeId: string) => void;
  readonly onDuplicate: () => void;
}) {
  const t = useTranslations("DashboardTemplates");
  const headingId = useId();
  const sharedInto = homes.filter((home) => template.sharedHomeIds.includes(home.id));
  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 text-fg shadow-raised"
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
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onDuplicate}
          data-testid="template-duplicate"
        >
          {t("saveCopy")}
        </Button>
      </div>
    </article>
  );
}
