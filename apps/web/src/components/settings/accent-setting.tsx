"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { DEFAULT_ACCENT, type AccentColor } from "@/accent/accent";
import { AccentPicker } from "@/components/accent/accent-picker";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";

import { SaveFailureAlert } from "./save-failure";
import { useSavePreferences } from "./use-save-preferences";

export interface AccentSettingProps {
  /** The saved global accent, or `null` for the default. */
  readonly initialColor: AccentColor | null;
}

/**
 * The account's global accent colour (S11): it colours Madeora in the Personal context and in
 * every Home without its own colour, and identifies the person to other members there. Saving
 * refreshes the page, so the new colour applies at once.
 */
export function AccentSetting({ initialColor }: AccentSettingProps) {
  const t = useTranslations("Settings");
  const hydrated = useHydrated();
  // `null` is the default accent (the spec's purple, in each theme's own shade). Picking the
  // palette's purple means the default, so it follows the theme like the default does.
  const [draft, setDraft] = useState<AccentColor | null>(initialColor);
  const [saved, setSaved] = useState<"saved" | "reset" | null>(null);
  const { mutation, saving, failure } = useSavePreferences((preferences) => {
    setDraft(preferences.accentColor);
    setSaved(preferences.accentColor === null ? "reset" : "saved");
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(null);
        mutation.mutate({ accentColor: draft });
      }}
      className="flex flex-col gap-4"
    >
      <AccentPicker
        legend={t("accentChoice")}
        value={draft ?? DEFAULT_ACCENT}
        previewColor={draft}
        onChange={(color) => {
          setSaved(null);
          setDraft(color === DEFAULT_ACCENT ? null : color);
        }}
      />
      <SaveFailureAlert failure={failure} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {saved === "reset" ? t("accentResetDone") : t("accentSaved")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={saving}>
          {t("save")}
        </Button>
        {initialColor !== null ? (
          <Button
            variant="secondary"
            disabled={!hydrated || saving}
            onClick={() => {
              setSaved(null);
              mutation.mutate({ accentColor: null });
            }}
          >
            {t("accentReset")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
