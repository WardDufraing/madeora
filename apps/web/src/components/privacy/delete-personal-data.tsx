"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { AccountChangeAction } from "@/auth/google-reauth";
import { FormAlert } from "@/components/auth/form-alert";
import { ReauthenticatedAction } from "@/components/account/reauthenticated-action";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { deletePersonalData, PrivacyActionError, type DeletionResult } from "@/privacy/api";
import {
  COPYABLE_DELETION_CATEGORIES,
  DELETION_CATEGORIES,
  type DeletionCategory,
} from "@/privacy/catalogue";
import { DATA_DELETION_PHRASES } from "@/privacy/schema";

export interface CategoryCounts {
  readonly items: number;
  readonly inTrash: number;
  readonly shared: number;
  readonly files: number;
  readonly openCopies: number;
}

export interface DeletePersonalDataProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly counts: Readonly<Record<DeletionCategory, CategoryCounts>>;
  readonly openExports: number;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Deleting personal data by category (S40 part 2, spec "Confirmed category-based deletion of adult
 * personal data"): choose categories, review what each affects, tick one acknowledgement per
 * category, type the confirmation word, then a fresh "confirm it's you". Never a bulk action: every
 * category is chosen and acknowledged on its own. Afterwards each category shows its own result; a
 * category that failed can be tried again on its own.
 */
export function DeletePersonalData({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  counts,
  openExports,
}: DeletePersonalDataProps) {
  const t = useTranslations("DataDeletion");
  const router = useRouter();
  const [selected, setSelected] = useState<readonly DeletionCategory[]>([]);
  const [acknowledged, setAcknowledged] = useState<readonly DeletionCategory[]>([]);
  const [phrase, setPhrase] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [result, setResult] = useState<DeletionResult | null>(null);

  const toggle = (
    list: readonly DeletionCategory[],
    category: DeletionCategory,
    on: boolean,
  ): DeletionCategory[] =>
    DELETION_CATEGORIES.filter((c) => (c === category ? on : list.includes(c)));

  const chosen = DELETION_CATEGORIES.filter((category) => selected.includes(category));
  const anyCopies = chosen.some(
    (category) => COPYABLE_DELETION_CATEGORIES.includes(category) && counts[category].shared > 0,
  );

  if (result) {
    const failed = DELETION_CATEGORIES.filter(
      (category) => result.results[category]?.outcome === "failed",
    );
    return (
      <div className="flex flex-col gap-4" data-testid="data-deletion-result">
        <FormAlert tone={result.status === "completed" ? "success" : "error"} announce>
          {t(`result.${result.status}`)}
        </FormAlert>
        <ul className="flex flex-col gap-2">
          {DELETION_CATEGORIES.filter((category) => result.results[category]).map((category) => {
            const entry = result.results[category];
            return (
              <li
                key={category}
                className="text-body"
                data-testid={`data-deletion-result-${category}`}
              >
                <span className="font-semibold">{t(`category.${category}`)}</span>
                {": "}
                {entry?.outcome === "deleted"
                  ? t("resultDeleted", { count: entry.count })
                  : t("resultFailed")}
              </li>
            );
          })}
        </ul>
        {failed.length > 0 ? (
          <button
            type="button"
            className="self-start text-body font-medium text-accent-fg underline"
            onClick={() => {
              setSelected(failed);
              setAcknowledged([]);
              setPhrase("");
              setRequestId(newRequestId());
              setResult(null);
            }}
          >
            {t("retryFailed")}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold">{t("chooseLegend")}</legend>
        {DELETION_CATEGORIES.map((category) => (
          <Checkbox
            key={category}
            label={t(`category.${category}`)}
            description={
              counts[category].items === 0
                ? t("countEmpty")
                : t("countItems", {
                    count: counts[category].items,
                    trash: counts[category].inTrash,
                  })
            }
            checked={selected.includes(category)}
            onChange={(event) => {
              const on = event.target.checked;
              setSelected((list) => toggle(list, category, on));
              if (!on) setAcknowledged((list) => toggle(list, category, false));
            }}
            data-testid={`data-deletion-category-${category}`}
          />
        ))}
      </fieldset>

      {chosen.length > 0 ? (
        <section aria-labelledby="data-deletion-impact" className="flex flex-col gap-3">
          <h2 id="data-deletion-impact" className="text-section-title">
            {t("impactTitle")}
          </h2>
          <FormAlert tone="info">{t("impactIrreversible")}</FormAlert>
          <ul
            className="flex list-disc flex-col gap-2 ps-5 text-body"
            data-testid="data-deletion-impact"
          >
            {chosen.map((category) => (
              <li key={category}>
                <span className="font-semibold">{t(`category.${category}`)}</span>
                {": "}
                {t(`impact.${category}`)}{" "}
                {counts[category].shared > 0
                  ? t("impactShared", { count: counts[category].shared })
                  : null}{" "}
                {counts[category].files > 0
                  ? t("impactFiles", { count: counts[category].files })
                  : null}{" "}
                {counts[category].openCopies > 0
                  ? t("impactCopies", { count: counts[category].openCopies })
                  : null}
              </li>
            ))}
            {anyCopies ? <li>{t("impactCopiesKept")}</li> : null}
            {chosen.includes("calendar") ? <li>{t("impactGoogle")}</li> : null}
            {openExports > 0 ? <li>{t("impactExports", { count: openExports })}</li> : null}
            <li>{t("impactUnchanged")}</li>
          </ul>
          <p className="text-body">
            {t("exportFirst")}{" "}
            <Link href="/settings/privacy/export" className="font-medium text-accent-fg underline">
              {t("exportLink")}
            </Link>
          </p>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-body font-semibold">{t("acknowledgeLegend")}</legend>
            {chosen.map((category) => (
              <Checkbox
                key={category}
                label={t("acknowledge", { category: t(`category.${category}`) })}
                checked={acknowledged.includes(category)}
                onChange={(event) => {
                  const on = event.target.checked;
                  setAcknowledged((list) => toggle(list, category, on));
                }}
                data-testid={`data-deletion-ack-${category}`}
              />
            ))}
          </fieldset>
          <ReauthenticatedAction
            action="delete_personal_data"
            email={email}
            userId={userId}
            twoFactor={twoFactor}
            hasPassword={hasPassword}
            confirmed={confirmed}
            label={t("delete", { count: chosen.length })}
            confirmIntro={t("confirmIntro")}
            testId="data-deletion"
            validate={() => {
              if (chosen.some((category) => !acknowledged.includes(category))) {
                return t("acknowledgeRequired");
              }
              return (DATA_DELETION_PHRASES as readonly string[]).includes(phrase.trim())
                ? null
                : t("phraseRequired");
            }}
            perform={async () => {
              try {
                const outcome = await deletePersonalData({
                  requestId,
                  categories: chosen,
                  confirmation: phrase.trim() as (typeof DATA_DELETION_PHRASES)[number],
                });
                setResult(outcome);
                router.refresh();
                return { kind: "done" };
              } catch (error) {
                const failure = error instanceof PrivacyActionError ? error.failure : "failed";
                if (failure === "reauthenticate") return { kind: "reauthenticate" };
                if (failure === "signedOut") {
                  window.location.assign(new URL("/sign-in", window.location.origin));
                  return { kind: "done" };
                }
                return { kind: "message", message: t("failed") };
              }
            }}
          >
            <TextField
              label={t("phraseLabel")}
              description={t("phraseHint")}
              autoComplete="off"
              spellCheck={false}
              value={phrase}
              onChange={(event) => {
                setPhrase(event.target.value);
              }}
              data-testid="data-deletion-phrase"
            />
          </ReauthenticatedAction>
        </section>
      ) : (
        <p className="text-helper text-fg-muted">{t("chooseHint")}</p>
      )}
    </div>
  );
}
