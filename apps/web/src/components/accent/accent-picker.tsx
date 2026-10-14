"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import {
  accentColorSchema,
  accentFill,
  accentPalette,
  paletteEntry,
  type AccentColor,
} from "@/accent/accent";
import { cx } from "@/components/ui/cx";

import { AccentPreview } from "./accent-preview";

export interface AccentPickerProps {
  /** The colour shown as chosen. */
  readonly value: AccentColor;
  readonly onChange: (color: AccentColor) => void;
  /** Visible group label. */
  readonly legend: string;
  readonly disabled?: boolean;
  /** What the preview shows when it differs from `value`: `null` for the theme's default accent. */
  readonly previewColor?: AccentColor | null;
}

/**
 * Chooses one solid colour (S11; spec "curated palettes plus a custom accent picker"): a labelled
 * swatch for each palette colour, so no choice is identified by colour alone, and a custom colour
 * with the browser's colour picker and a hex field for keyboard and screen-reader users. Native
 * radio buttons give arrow-key navigation. The preview shows the colour as the interface will
 * draw it in the theme on screen, and says when it was adjusted for readable text.
 */
export function AccentPicker({
  value,
  onChange,
  legend,
  disabled = false,
  previewColor = value,
}: AccentPickerProps) {
  const t = useTranslations("Accent");
  const name = useId();
  const hexId = useId();
  const hexHintId = useId();
  const hexErrorId = useId();
  const inPalette = paletteEntry(value) !== undefined;
  // A custom colour starts from the chosen palette colour, so the picker opens somewhere sensible.
  const [custom, setCustom] = useState<AccentColor>(value);
  const [hexText, setHexText] = useState<string>(value);
  const [hexInvalid, setHexInvalid] = useState(false);
  // "Your own colour" stays chosen once picked, even while its colour equals a palette colour.
  const [customMode, setCustomMode] = useState(!inPalette);
  const customChosen = customMode || !inPalette;
  const { adjusted } = accentFill(value);

  const chooseCustom = (color: AccentColor) => {
    setCustomMode(true);
    setCustom(color);
    setHexText(color);
    setHexInvalid(false);
    onChange(color);
  };

  return (
    <fieldset className="flex flex-col gap-4" disabled={disabled}>
      <legend className="mb-2 text-body font-medium text-fg">{legend}</legend>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {accentPalette.map((entry) => (
          <label
            key={entry.id}
            className="flex min-h-10 cursor-pointer items-center gap-3 text-body text-fg"
          >
            <input
              type="radio"
              name={name}
              value={entry.color}
              checked={!customChosen && value === entry.color}
              onChange={() => {
                setCustomMode(false);
                onChange(entry.color);
              }}
              className="size-5 shrink-0 cursor-pointer accent-accent"
            />
            <span
              aria-hidden="true"
              className="size-6 shrink-0 rounded-full border border-line-control"
              style={{ backgroundColor: `var(--md-color-palette-${entry.id})` }}
            />
            <span>{t(entry.id)}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex min-h-10 cursor-pointer items-center gap-3 text-body text-fg">
          <input
            type="radio"
            name={name}
            value="custom"
            checked={customChosen}
            onChange={() => {
              setCustomMode(true);
              onChange(custom);
            }}
            className="size-5 shrink-0 cursor-pointer accent-accent"
          />
          <span>{t("custom")}</span>
        </label>
        <div className="flex flex-wrap items-end gap-3 ps-8">
          <input
            type="color"
            value={custom}
            aria-label={t("customPicker")}
            onChange={(event) => {
              const parsed = accentColorSchema.safeParse(event.target.value);
              if (parsed.success) chooseCustom(parsed.data);
            }}
            className="h-10 w-14 cursor-pointer rounded-control border border-line-control bg-surface p-1"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={hexId} className="text-helper font-medium text-fg">
              {t("customHex")}
            </label>
            <input
              id={hexId}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={7}
              value={hexText}
              aria-describedby={hexInvalid ? `${hexHintId} ${hexErrorId}` : hexHintId}
              aria-invalid={hexInvalid || undefined}
              onChange={(event) => {
                setHexText(event.target.value);
                const parsed = accentColorSchema.safeParse(event.target.value);
                if (parsed.success) chooseCustom(parsed.data);
              }}
              onBlur={() => {
                setHexInvalid(!accentColorSchema.safeParse(hexText).success);
              }}
              className={cx(
                "min-h-10 w-32 rounded-control border bg-surface px-3 font-mono text-body text-fg",
                hexInvalid ? "border-danger" : "border-line-control",
              )}
            />
          </div>
        </div>
        <p id={hexHintId} className="ps-8 text-helper text-fg-muted">
          {t("customHexHint")}
        </p>
        {hexInvalid ? (
          <p id={hexErrorId} className="ps-8 text-helper text-danger">
            {t("accentInvalid")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3" data-testid="accent-preview">
        <span className="text-helper text-fg-muted">{t("preview")}</span>
        <AccentPreview color={previewColor}>
          <span className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent">
            {t("sample")}
          </span>
        </AccentPreview>
        {adjusted ? <span className="text-helper text-fg-muted">{t("adjusted")}</span> : null}
      </div>
    </fieldset>
  );
}
