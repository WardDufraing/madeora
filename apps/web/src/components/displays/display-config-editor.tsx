"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { saveDisplayConfig, setDisplayLock, type SaveConfigResult } from "@/displays/api";
import {
  LOCK_MESSAGE_MAX,
  MAX_DISPLAY_WIDGETS,
  MAX_SHOPPING_LISTS,
  defaultDisplayLayout,
  defaultDisplayPreferences,
  displayClockFormats,
  displayColumns,
  displayCounts,
  displayDensities,
  displayOrientations,
  displayThemes,
  displayWidgetSizes,
  displayWidgetTypes,
  lockMessageSchema,
  newDisplayWidget,
  widgetSpan,
  type DisplayLayout,
  type DisplayPreferences,
  type DisplayWidget,
  type DisplayWidgetType,
} from "@/displays/layout";
import { MemberActionError, type MemberFailure } from "@/members/manage-api";

export interface DisplayConfigView {
  readonly layout: DisplayLayout | null;
  readonly preferences: DisplayPreferences;
  readonly revision: number;
  readonly locked: boolean;
  readonly lockMessage: string | null;
  readonly applied: boolean;
  readonly shoppingLists: readonly { readonly id: string; readonly name: string }[];
}

type Notice = "saved" | "restored" | "locked" | "unlocked" | "messageSaved" | null;

function countOption(value: number) {
  return { value: String(value), label: String(value) };
}

/**
 * One Household Display's own configuration (S44; spec "Confirmed independent layouts for each
 * Household Display"): its privacy/party lock and welcome message, its widgets (add, remove, move
 * up and down, size and settings), orientation, theme, density and clock, with a preview of the
 * arrangement in landscape and portrait. Saving is checked against the revision that was loaded,
 * so a concurrent edit by another manager is reported instead of overwritten. Nothing here
 * changes another display, the Home dashboard or anyone's personal settings.
 */
export function DisplayConfigEditor({
  homeId,
  displayId,
  displayName,
  config,
}: {
  readonly homeId: string;
  readonly displayId: string;
  readonly displayName: string;
  readonly config: DisplayConfigView;
}) {
  const t = useTranslations("DisplayConfig");
  const router = useRouter();
  const hydrated = useHydrated();
  const loadedLayout = config.layout ?? defaultDisplayLayout;
  const [layout, setLayout] = useState<DisplayLayout>(loadedLayout);
  const [preferences, setPreferences] = useState<DisplayPreferences>(config.preferences);
  const [revision, setRevision] = useState(config.revision);
  const [adding, setAdding] = useState<DisplayWidgetType>("chores");
  const [previewPortrait, setPreviewPortrait] = useState(
    config.preferences.orientation === "portrait",
  );
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<
    Extract<SaveConfigResult, { kind: "failed" }>["failure"] | "conflict" | null
  >(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [message, setMessage] = useState(config.lockMessage ?? "");
  const [messageError, setMessageError] = useState(false);
  const [lockPending, setLockPending] = useState(false);
  const [lockFailure, setLockFailure] = useState<MemberFailure | null>(null);

  const dirty =
    JSON.stringify(layout) !== JSON.stringify(loadedLayout) ||
    JSON.stringify(preferences) !== JSON.stringify(config.preferences);
  const listIds = new Set(config.shoppingLists.map((list) => list.id));
  const missingLists = layout.widgets.some(
    (widget) => widget.type === "shopping" && widget.config.listIds.some((id) => !listIds.has(id)),
  );

  const update = (index: number, widget: DisplayWidget) => {
    setNotice(null);
    setLayout((current) => ({
      ...current,
      widgets: current.widgets.map((item, at) => (at === index ? widget : item)),
    }));
  };
  const move = (index: number, by: -1 | 1) => {
    setNotice(null);
    setLayout((current) => {
      const widgets = [...current.widgets];
      const target = index + by;
      const moving = widgets[index];
      const other = widgets[target];
      if (!moving || !other) return current;
      widgets[index] = other;
      widgets[target] = moving;
      return { ...current, widgets };
    });
  };
  const remove = (index: number) => {
    setNotice(null);
    setLayout((current) => ({
      ...current,
      widgets: current.widgets.filter((_, at) => at !== index),
    }));
  };

  const save = async (restore: boolean) => {
    if (saving) return;
    setSaving(true);
    setSaveFailure(null);
    setNotice(null);
    const result = await saveDisplayConfig(homeId, displayId, {
      expectedRevision: revision,
      layout: restore ? null : layout,
      preferences: restore ? defaultDisplayPreferences : preferences,
    });
    setSaving(false);
    if (result.kind === "saved") {
      setRevision(result.revision);
      if (restore) {
        setLayout(defaultDisplayLayout);
        setPreferences(defaultDisplayPreferences);
      }
      setNotice(restore ? "restored" : "saved");
      router.refresh();
      return;
    }
    setSaveFailure(result.kind === "conflict" ? "conflict" : result.failure);
  };

  const changeLock = async (locked: boolean) => {
    const parsed = lockMessageSchema.safeParse(message);
    if (!parsed.success) {
      setMessageError(true);
      return;
    }
    setMessageError(false);
    setLockPending(true);
    setLockFailure(null);
    setNotice(null);
    try {
      await setDisplayLock(homeId, displayId, { locked, message });
      setNotice(locked === config.locked ? "messageSaved" : locked ? "locked" : "unlocked");
      router.refresh();
    } catch (error) {
      setLockFailure(error instanceof MemberActionError ? error.failure : "failed");
    } finally {
      setLockPending(false);
    }
  };

  const columns = displayColumns(previewPortrait ? "portrait" : "landscape");
  const sizeOptions = displayWidgetSizes.map((size) => ({ value: size, label: t(`size.${size}`) }));

  return (
    <div className="flex flex-col gap-8">
      {notice ? (
        <FormAlert tone="success" announce>
          {t(`notice.${notice}`)}
        </FormAlert>
      ) : null}
      <p className="text-helper text-fg-muted" data-testid="display-config-applied">
        {config.applied ? t("applied") : t("notApplied")}
      </p>

      <section className="flex flex-col gap-4" aria-labelledby="display-lock-title">
        <h2 id="display-lock-title" className="text-section-title font-semibold text-fg">
          {t("lockTitle")}
        </h2>
        <p className="text-body text-fg-muted">{t("lockIntro", { name: displayName })}</p>
        <p className="text-body font-medium text-fg" data-testid="display-lock-state">
          {config.locked ? t("lockOn") : t("lockOff")}
        </p>
        <TextField
          label={t("messageLabel")}
          description={t("messageHint", { max: LOCK_MESSAGE_MAX })}
          value={message}
          maxLength={LOCK_MESSAGE_MAX}
          error={messageError ? t("messageInvalid") : undefined}
          onChange={(event) => {
            setMessage(event.target.value);
            setMessageError(false);
          }}
        />
        <MemberFailureAlert failure={lockFailure} />
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            disabled={!hydrated}
            loading={lockPending}
            onClick={() => void changeLock(!config.locked)}
          >
            {config.locked ? t("unlock") : t("lock")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated || lockPending}
            onClick={() => void changeLock(config.locked)}
          >
            {t("saveMessage")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="display-layout-title">
        <h2 id="display-layout-title" className="text-section-title font-semibold text-fg">
          {t("layoutTitle")}
        </h2>
        <p className="text-body text-fg-muted">{t("layoutIntro")}</p>
        {missingLists ? <FormAlert tone="info">{t("missingLists")}</FormAlert> : null}
        {layout.widgets.length === 0 ? (
          <p className="text-body text-fg-muted">{t("noWidgets")}</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="display-config-widgets">
            {layout.widgets.map((widget, index) => {
              const name = t(`widget.${widget.type}`);
              return (
                <li
                  key={widget.id}
                  className="flex flex-col gap-3 rounded-control border border-line p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-body font-semibold text-fg">
                      {t("widgetPosition", { position: index + 1, name })}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={index === 0}
                        aria-label={t("moveUpNamed", { name, position: index + 1 })}
                        onClick={() => {
                          move(index, -1);
                        }}
                      >
                        {t("moveUp")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={index === layout.widgets.length - 1}
                        aria-label={t("moveDownNamed", { name, position: index + 1 })}
                        onClick={() => {
                          move(index, 1);
                        }}
                      >
                        {t("moveDown")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={t("removeNamed", { name, position: index + 1 })}
                        onClick={() => {
                          remove(index);
                        }}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  </div>
                  <SelectField
                    label={t("sizeLabel")}
                    options={sizeOptions}
                    value={widget.size}
                    onChange={(event) => {
                      const size = displayWidgetSizes.find((value) => value === event.target.value);
                      if (size) update(index, { ...widget, size });
                    }}
                  />
                  {widget.type === "clock" ? (
                    <Checkbox
                      label={t("showDate")}
                      checked={widget.config.showDate}
                      onChange={(event) => {
                        update(index, {
                          ...widget,
                          config: { ...widget.config, showDate: event.target.checked },
                        });
                      }}
                    />
                  ) : null}
                  {widget.type === "chores" ? (
                    <>
                      <Checkbox
                        label={t("choreActions")}
                        description={t("choreActionsHint")}
                        checked={widget.config.actions}
                        onChange={(event) => {
                          update(index, {
                            ...widget,
                            config: { ...widget.config, actions: event.target.checked },
                          });
                        }}
                      />
                      <SelectField
                        label={t("countLabel")}
                        options={displayCounts.map(countOption)}
                        value={String(widget.config.count)}
                        onChange={(event) => {
                          const count = displayCounts.find((n) => String(n) === event.target.value);
                          if (count)
                            update(index, { ...widget, config: { ...widget.config, count } });
                        }}
                      />
                    </>
                  ) : null}
                  {widget.type === "shopping" ? (
                    <>
                      <fieldset className="flex flex-col gap-2">
                        <legend className="text-body font-medium text-fg">
                          {t("listsLabel", { max: MAX_SHOPPING_LISTS })}
                        </legend>
                        {config.shoppingLists.length === 0 ? (
                          <p className="text-helper text-fg-muted">{t("noLists")}</p>
                        ) : (
                          config.shoppingLists.map((list) => {
                            const chosen = widget.config.listIds.includes(list.id);
                            return (
                              <Checkbox
                                key={list.id}
                                label={list.name}
                                checked={chosen}
                                disabled={
                                  !chosen && widget.config.listIds.length >= MAX_SHOPPING_LISTS
                                }
                                onChange={(event) => {
                                  const listIds = event.target.checked
                                    ? [...widget.config.listIds, list.id]
                                    : widget.config.listIds.filter((id) => id !== list.id);
                                  update(index, {
                                    ...widget,
                                    config: { ...widget.config, listIds },
                                  });
                                }}
                              />
                            );
                          })
                        )}
                        <p className="text-helper text-fg-muted">{t("listsHint")}</p>
                      </fieldset>
                      <SelectField
                        label={t("itemCountLabel")}
                        options={displayCounts.map(countOption)}
                        value={String(widget.config.count)}
                        onChange={(event) => {
                          const count = displayCounts.find((n) => String(n) === event.target.value);
                          if (count)
                            update(index, { ...widget, config: { ...widget.config, count } });
                        }}
                      />
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {layout.widgets.length < MAX_DISPLAY_WIDGETS ? (
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label={t("addLabel")}
              options={displayWidgetTypes.map((type) => ({
                value: type,
                label: t(`widget.${type}`),
              }))}
              value={adding}
              onChange={(event) => {
                const type = displayWidgetTypes.find((value) => value === event.target.value);
                if (type) setAdding(type);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!hydrated}
              onClick={() => {
                setNotice(null);
                setLayout((current) => ({
                  ...current,
                  widgets: [...current.widgets, newDisplayWidget(adding, crypto.randomUUID())],
                }));
              }}
            >
              {t("add")}
            </Button>
          </div>
        ) : (
          <p className="text-helper text-fg-muted">
            {t("limitReached", { max: MAX_DISPLAY_WIDGETS })}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="display-presentation-title">
        <h2 id="display-presentation-title" className="text-section-title font-semibold text-fg">
          {t("presentationTitle")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label={t("orientationLabel")}
            options={displayOrientations.map((value) => ({
              value,
              label: t(`orientation.${value}`),
            }))}
            value={preferences.orientation}
            onChange={(event) => {
              const orientation = displayOrientations.find((v) => v === event.target.value);
              if (!orientation) return;
              setNotice(null);
              setPreferences({ ...preferences, orientation });
              if (orientation !== "auto") setPreviewPortrait(orientation === "portrait");
            }}
          />
          <SelectField
            label={t("themeLabel")}
            options={displayThemes.map((value) => ({ value, label: t(`theme.${value}`) }))}
            value={preferences.theme}
            onChange={(event) => {
              const theme = displayThemes.find((v) => v === event.target.value);
              if (theme) setPreferences({ ...preferences, theme });
            }}
          />
          <SelectField
            label={t("densityLabel")}
            options={displayDensities.map((value) => ({ value, label: t(`density.${value}`) }))}
            value={preferences.density}
            onChange={(event) => {
              const density = displayDensities.find((v) => v === event.target.value);
              if (density) setPreferences({ ...preferences, density });
            }}
          />
          <SelectField
            label={t("clockLabel")}
            options={displayClockFormats.map((value) => ({ value, label: t(`clock.${value}`) }))}
            value={preferences.clockFormat}
            onChange={(event) => {
              const clockFormat = displayClockFormats.find((v) => v === event.target.value);
              if (clockFormat) setPreferences({ ...preferences, clockFormat });
            }}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="display-preview-title">
        <h2 id="display-preview-title" className="text-section-title font-semibold text-fg">
          {t("previewTitle")}
        </h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("previewOrientation")}>
          <Button
            type="button"
            size="sm"
            variant={previewPortrait ? "secondary" : "primary"}
            aria-pressed={!previewPortrait}
            disabled={preferences.orientation === "portrait"}
            onClick={() => {
              setPreviewPortrait(false);
            }}
          >
            {t("orientation.landscape")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={previewPortrait ? "primary" : "secondary"}
            aria-pressed={previewPortrait}
            disabled={preferences.orientation === "landscape"}
            onClick={() => {
              setPreviewPortrait(true);
            }}
          >
            {t("orientation.portrait")}
          </Button>
        </div>
        <div
          className={`grid gap-2 rounded-card border border-line bg-surface-sunken p-3 [grid-auto-flow:dense] [grid-template-columns:repeat(var(--preview-columns),minmax(0,1fr))] ${previewPortrait ? "aspect-[10/16] w-48" : "aspect-[16/10] w-80"}`}
          style={{ "--preview-columns": columns } as CSSProperties}
          data-testid="display-config-preview"
          aria-hidden="true"
        >
          {layout.widgets.map((widget) => {
            const span = widgetSpan(widget.size, columns);
            return (
              <div
                key={widget.id}
                className="flex items-center justify-center overflow-hidden rounded-control border border-line bg-surface p-1 text-helper text-fg-muted [grid-column:span_var(--span-columns)] [grid-row:span_var(--span-rows)]"
                style={
                  { "--span-columns": span.columns, "--span-rows": span.rows } as CSSProperties
                }
              >
                {t(`widget.${widget.type}`)}
              </div>
            );
          })}
        </div>
      </section>

      {saveFailure === "conflict" ? (
        <FormAlert tone="error" announce>
          {t("conflict")}
        </FormAlert>
      ) : saveFailure ? (
        <FormAlert tone="error" announce>
          {t(`saveFail.${saveFailure}`)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          disabled={!hydrated || !dirty}
          loading={saving}
          onClick={() => void save(false)}
        >
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || saving}
          onClick={() => {
            setLayout(loadedLayout);
            setPreferences(config.preferences);
            setSaveFailure(null);
          }}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!hydrated || saving}
          onClick={() => void save(true)}
        >
          {t("restore")}
        </Button>
      </div>
    </div>
  );
}
