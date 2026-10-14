"use client";

import type { HomeRole } from "@madeora/domain/permissions";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { effectiveAccent, type AccentColor } from "@/accent/accent";
import { closestClash, suggestDistinctColors } from "@/accent/similarity";
import { AccentPicker } from "@/components/accent/accent-picker";
import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { useRoleLabel } from "@/components/shell/use-role-label";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { HomeProfileSaveFailure } from "@/members/profile-api";
import {
  effectiveHomeName,
  type HomeNameSource,
  type HomeProfileOverrides,
} from "@/members/profile-schema";
import { useSaveHomeProfile } from "@/members/use-save-home-profile";

import { MemberAvatar } from "./member-avatar";
import { NameOverrideField } from "./name-override-field";

export interface HomeProfileFormProps {
  readonly homeId: string;
  readonly homeName: string;
  /** The person's role in this Home, for the preview. */
  readonly homeRole: HomeRole;
  /** The account's global display name and accent, which every field inherits by default. */
  readonly globalName: string | null;
  readonly globalAccent: AccentColor | null;
  /** What this person saved for this Home. */
  readonly overrides: HomeProfileOverrides;
  /** The effective colours of the other current members of this Home, for the clash warning. */
  readonly otherColors: readonly AccentColor[];
}

const failureKey = {
  signedOut: "saveSignedOut",
  invalid: "saveInvalid",
  notFound: "saveNotFound",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<HomeProfileSaveFailure, string>;

/**
 * "How you appear in this Home" (S11): nickname, Home display name and colour, each saved on its
 * own and each showing what it inherits, with a live preview of what other members see. Only the
 * person themselves reaches this form; the API and RLS write only their own row.
 */
export function HomeProfileForm({
  homeId,
  homeName,
  homeRole,
  globalName,
  globalAccent,
  overrides,
  otherColors,
}: HomeProfileFormProps) {
  const t = useTranslations("Members");
  const tAccent = useTranslations("Accent");
  const locale = useLocale();
  const roleLabel = useRoleLabel();
  const hydrated = useHydrated();

  // Unsaved text in the name fields, for the preview: `undefined` while a field shows its saved
  // value, `null` when the person cleared it.
  const [nicknameDraft, setNicknameDraft] = useState<string | null | undefined>(undefined);
  const [homeNameDraft, setHomeNameDraft] = useState<string | null | undefined>(undefined);
  const preview = effectiveHomeName(
    {
      nickname: nicknameDraft === undefined ? overrides.nickname : nicknameDraft,
      displayName: homeNameDraft === undefined ? overrides.displayName : homeNameDraft,
    },
    globalName,
  );

  const [ownColor, setOwnColor] = useState(overrides.accentColor !== null);
  const [colorDraft, setColorDraft] = useState<AccentColor>(
    effectiveAccent(overrides.accentColor, globalAccent),
  );
  const [colorSaved, setColorSaved] = useState(false);
  const colorSave = useSaveHomeProfile(homeId, () => {
    setColorSaved(true);
  });
  const previewColor = ownColor ? colorDraft : effectiveAccent(null, globalAccent);
  const clash = closestClash(previewColor, otherColors);
  const suggestions = clash === "distinct" ? [] : suggestDistinctColors(otherColors);

  const sourceText: Record<HomeNameSource, string> = {
    nickname: t("sourceNickname"),
    homeName: t("sourceHomeName"),
    global: t("sourceGlobal"),
    none: t("sourceNone"),
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card title={t("previewTitle")} description={t("previewHint", { home: homeName })}>
        <div className="flex items-center gap-4" data-testid="profile-preview">
          <MemberAvatar name={preview.name} accentColor={previewColor} locale={locale} size="lg" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-fg">
              {preview.name === null ? t("noName") : <bdi>{preview.name}</bdi>}
            </span>
            <span className="text-helper text-fg-muted">{roleLabel(homeRole)}</span>
          </div>
        </div>
        <p className="mt-3 text-helper text-fg-muted" data-testid="name-source">
          {sourceText[preview.source]}
        </p>
      </Card>

      <Card title={t("nameSection")} description={t("nameSectionHint")}>
        <div className="flex flex-col gap-8">
          <NameOverrideField
            homeId={homeId}
            field="nickname"
            saved={overrides.nickname}
            onDraftChange={setNicknameDraft}
          />
          <NameOverrideField
            homeId={homeId}
            field="displayName"
            saved={overrides.displayName}
            inherited={globalName}
            onDraftChange={setHomeNameDraft}
          />
        </div>
      </Card>

      <Card title={t("colourSection")} description={t("colourSectionHint")}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setColorSaved(false);
            colorSave.mutation.mutate({ accentColor: ownColor ? colorDraft : null });
          }}
          className="flex flex-col gap-4"
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-2 text-body font-medium text-fg">{t("colourChoice")}</legend>
            <RadioOption
              name="home-colour-mode"
              label={t("useGlobalColour")}
              description={
                globalAccent === null ? t("useGlobalColourDefault") : t("useGlobalColourHint")
              }
              checked={!ownColor}
              onChange={() => {
                setColorSaved(false);
                setOwnColor(false);
              }}
            />
            <RadioOption
              name="home-colour-mode"
              label={t("useHomeColour")}
              checked={ownColor}
              onChange={() => {
                setColorSaved(false);
                setOwnColor(true);
              }}
            />
          </fieldset>
          {ownColor ? (
            <AccentPicker
              legend={t("homeColour")}
              value={colorDraft}
              onChange={(color) => {
                setColorSaved(false);
                setColorDraft(color);
              }}
            />
          ) : null}
          {clash !== "distinct" ? (
            <FormAlert tone="info" announce>
              <p data-testid="colour-clash">
                {clash === "identical" ? t("clashIdentical") : t("clashSimilar")}
              </p>
              {suggestions.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map((suggestion) => (
                    <Button
                      key={suggestion.id}
                      size="sm"
                      variant="secondary"
                      icon={
                        <span
                          aria-hidden="true"
                          className="size-4 rounded-full border border-line-control"
                          style={{ backgroundColor: `var(--md-color-palette-${suggestion.id})` }}
                        />
                      }
                      onClick={() => {
                        setColorSaved(false);
                        setOwnColor(true);
                        setColorDraft(suggestion.color);
                      }}
                    >
                      {t("useSuggestion", { colour: tAccent(suggestion.id) })}
                    </Button>
                  ))}
                </div>
              ) : null}
            </FormAlert>
          ) : null}
          {colorSave.failure ? (
            <FormAlert tone="error" announce>
              {t(failureKey[colorSave.failure])}
            </FormAlert>
          ) : null}
          {colorSaved && !colorSave.mutation.isPending ? (
            <FormAlert tone="success" announce>
              {t("colourSaved")}
            </FormAlert>
          ) : null}
          <div>
            <Button type="submit" disabled={!hydrated} loading={colorSave.saving}>
              {t("saveColour")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
