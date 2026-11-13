"use client";

import { CheckIcon } from "@madeora/icons";
import { oraPaletteKeys, oraPalettes, type OraPaletteKey } from "@madeora/design-tokens";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { saveOraSettings, type OraSaveError, type OraSaveFailure } from "@/ora/api";
import type { OraPatch, OraSettings } from "@/ora/settings";
import { defaultOraSettings } from "@/ora/settings";
import { oraMotionModes, type OraMotionMode } from "@/ora/types";

import { OraCharacter } from "./ora-character";

export interface OraSettingsFormProps {
  readonly settings: OraSettings;
  readonly homes: readonly { readonly id: string; readonly name: string }[];
}

const failureKey = {
  signedOut: "saveSignedOut",
  forbidden: "saveForbidden",
  invalid: "saveFailed",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<OraSaveFailure, string>;

/**
 * The person's own Ora settings. Each change saves at once through the API (the form has no Save
 * button); a failed save puts the control back and says why. The page refreshes after a save so
 * Ora itself (outside this form) follows immediately.
 */
export function OraSettingsForm({ settings, homes }: OraSettingsFormProps) {
  const t = useTranslations("OraSettings");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useState(settings);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation<
    unknown,
    OraSaveError,
    { patch: OraPatch; revert: (state: OraSettings) => OraSettings }
  >({
    mutationFn: ({ patch }) => saveOraSettings(patch),
    scope: { id: "ora-settings" },
    onSuccess: () => {
      setSaved(true);
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error, { revert }) => {
      setCurrent(revert);
      setSaved(false);
      if (error.failure === "signedOut") router.refresh();
    },
  });

  // `revert` undoes only this change, so a failure never undoes a later successful one.
  function change(
    patch: OraPatch,
    next: (state: OraSettings) => OraSettings,
    revert: (state: OraSettings) => OraSettings,
  ) {
    setCurrent(next);
    setSaved(false);
    mutation.mutate({ patch, revert });
  }

  const failure = mutation.error?.failure ?? null;
  const enabledId = useId();
  const enabledHintId = useId();
  const teasersId = useId();
  const teasersHintId = useId();
  const personalPalette = current.personalPalette;

  return (
    <div className="flex flex-col gap-6">
      <div role="status" className="min-h-6 text-helper text-fg-muted">
        {saved && !mutation.isPending ? t("saved") : null}
      </div>
      {failure ? (
        <FormAlert tone="error" announce>
          {t(failureKey[failure])}
        </FormAlert>
      ) : null}

      <Card title={t("enabledTitle")}>
        <div className="flex items-start gap-3">
          <input
            id={enabledId}
            type="checkbox"
            role="switch"
            checked={current.enabled}
            aria-describedby={enabledHintId}
            onChange={(event) => {
              const value = event.target.checked;
              change(
                { enabled: value },
                (state) => ({ ...state, enabled: value }),
                (state) => ({ ...state, enabled: !value }),
              );
            }}
            className="mt-1 size-5 shrink-0 cursor-pointer accent-accent"
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={enabledId} className="cursor-pointer text-body font-medium">
              {current.enabled ? t("enabledOn") : t("enabledOff")}
            </label>
            <p id={enabledHintId} className="text-helper text-fg-muted">
              {t("enabledHint")}
            </p>
          </div>
        </div>
      </Card>

      <Card title={t("teasersTitle")}>
        <div className="flex items-start gap-3">
          <input
            id={teasersId}
            type="checkbox"
            role="switch"
            checked={!current.teasersMuted}
            aria-describedby={teasersHintId}
            onChange={(event) => {
              const muted = !event.target.checked;
              change(
                { teasersMuted: muted },
                (state) => ({ ...state, teasersMuted: muted }),
                (state) => ({ ...state, teasersMuted: !muted }),
              );
            }}
            className="mt-1 size-5 shrink-0 cursor-pointer accent-accent"
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={teasersId} className="cursor-pointer text-body font-medium">
              {current.teasersMuted ? t("teasersOff") : t("teasersOn")}
            </label>
            <p id={teasersHintId} className="text-helper text-fg-muted">
              {t("teasersHint")}
            </p>
          </div>
        </div>
      </Card>

      <Card title={t("motionTitle")} description={t("motionHint")}>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t("motionTitle")}</legend>
          {oraMotionModes.map((mode) => (
            <RadioOption
              key={mode}
              name="ora-motion"
              value={mode}
              label={t(`motion.${mode}`)}
              description={t(`motionHints.${mode}`)}
              checked={current.motion === mode}
              onChange={() => {
                const previous = current.motion;
                change(
                  { motion: mode },
                  (state) => ({ ...state, motion: mode }),
                  (state) => ({ ...state, motion: previous }),
                );
              }}
            />
          ))}
        </fieldset>
      </Card>

      <Card title={t("coloursTitle")} description={t("coloursHint")}>
        <div className="flex flex-col gap-6">
          <PaletteChooser
            name="ora-palette-personal"
            legend={t("personalColour")}
            value={personalPalette}
            motion={current.motion}
            onChoose={(palette) => {
              const previous = current.personalPalette;
              change(
                { personalPalette: palette },
                (state) => ({ ...state, personalPalette: palette }),
                (state) => ({ ...state, personalPalette: previous }),
              );
            }}
          />
          {homes.map((home) => (
            <PaletteChooser
              key={home.id}
              name={`ora-palette-${home.id}`}
              legend={home.name}
              value={current.homePalettes[home.id] ?? defaultOraSettings.personalPalette}
              motion={current.motion}
              onChoose={(palette) => {
                const previous = current.homePalettes[home.id];
                change(
                  { homePalette: { homeId: home.id, palette } },
                  (state) => ({
                    ...state,
                    homePalettes: { ...state.homePalettes, [home.id]: palette },
                  }),
                  (state) => {
                    const homePalettes = Object.fromEntries(
                      Object.entries(state.homePalettes).filter(([id]) => id !== home.id),
                    );
                    if (previous !== undefined) homePalettes[home.id] = previous;
                    return { ...state, homePalettes };
                  },
                );
              }}
            />
          ))}
          {homes.length === 0 ? <p className="text-helper text-fg-muted">{t("noHomes")}</p> : null}
        </div>
      </Card>
    </div>
  );
}

function PaletteChooser({
  name,
  legend,
  value,
  motion,
  onChoose,
}: {
  readonly name: string;
  readonly legend: string;
  readonly value: OraPaletteKey;
  readonly motion: OraMotionMode;
  readonly onChoose: (palette: OraPaletteKey) => void;
}) {
  const t = useTranslations("OraSettings");
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-body font-semibold text-fg">{legend}</legend>
      <div className="flex items-center gap-4">
        <OraCharacter palette={value} motion={motion} className="w-20 shrink-0" />
        <div className="flex flex-wrap gap-2">
          {oraPaletteKeys.map((key) => {
            const selected = key === value;
            return (
              <label key={key} className="cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  value={key}
                  checked={selected}
                  onChange={() => {
                    onChoose(key);
                  }}
                  className="peer sr-only"
                />
                <span
                  className={cx(
                    "flex w-20 flex-col items-center gap-1 rounded-control border p-2 text-center text-helper text-fg",
                    "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
                    selected
                      ? "border-fg bg-accent-subtle font-semibold"
                      : "border-line hover:bg-accent-subtle",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="relative flex size-8 items-center justify-center rounded-full border border-line"
                    style={{ backgroundColor: oraPalettes[key].body[2] }}
                  >
                    {selected ? <CheckIcon size="sm" className="text-fg" /> : null}
                  </span>
                  <span>{t(`palettes.${key}`)}</span>
                  {selected ? <span className="sr-only">{t("selected")}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
