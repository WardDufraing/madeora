"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { recipeEndpoint, sendRecipeRequest, type RecipeShare } from "@/recipes/api";

import { useRecipeFailure } from "./use-recipe-texts";
import { useRecipeMutation } from "./use-recipe-mutation";

export interface RecipeSharePanelProps {
  readonly recipeId: string;
  readonly recipeName: string;
  readonly shares: readonly RecipeShare[];
}

type Change =
  | { readonly kind: "share"; readonly homeId: string; readonly canEdit: boolean }
  | { readonly kind: "unshare"; readonly homeId: string };

/**
 * Where one recipe is shared (S25, spec "explicitly synchronized cross-context sharing"), for a
 * recipe manager of its origin: each Home it is shared with (view only, or its recipe managers may
 * edit too), shares paused since the recipe was deleted (reinstate or remove), and sharing with
 * another Home the person belongs to, confirmed after the consequences are shown. One recipe,
 * never a copy: a change anyone saves shows everywhere it is shared.
 */
export function RecipeSharePanel({ recipeId, recipeName, shares }: RecipeSharePanelProps) {
  const t = useTranslations("Recipes");
  const failure = useRecipeFailure();
  const { announce, region } = useAnnouncer();
  const available = shares.filter((share) => share.state === "available");
  const current = shares.filter((share) => share.state !== "available");
  const [target, setTarget] = useState(available[0]?.homeId ?? "");
  const [canEdit, setCanEdit] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Removing a share or making it view only takes something away from that Home: confirmed first.
  const [narrowing, setNarrowing] = useState<{
    readonly change: Change;
    readonly homeName: string;
  } | null>(null);
  const mutation = useRecipeMutation(
    `recipe:${recipeId}:share`,
    (change: Change) =>
      change.kind === "share"
        ? sendRecipeRequest<object>("PUT", recipeEndpoint(recipeId, "shares"), {
            homeId: change.homeId,
            canEdit: change.canEdit,
          })
        : sendRecipeRequest<object>("DELETE", recipeEndpoint(recipeId, "shares"), {
            homeId: change.homeId,
          }),
    (_answer, change) => {
      setConfirming(false);
      setNarrowing(null);
      announce(change.kind === "share" ? t("shareSaved") : t("shareRemoved"));
    },
  );
  const targetName = available.find((home) => home.homeId === target)?.homeName ?? "";
  // A Home the list no longer offers (shared meanwhile) falls back to the first one left.
  const selected = available.some((home) => home.homeId === target)
    ? target
    : (available[0]?.homeId ?? "");

  return (
    <div className="flex flex-col gap-6" data-testid="recipe-share-panel">
      {region}
      <FormAlert tone="info">{t("shareExplainer")}</FormAlert>
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {failure(mutation.error.failure)}
        </FormAlert>
      ) : null}
      <section aria-labelledby="shared-with-heading" className="flex flex-col gap-3">
        <h2 id="shared-with-heading" className="text-section-title font-semibold text-fg">
          {t("sharedWithHeading")}
        </h2>
        {current.length === 0 ? (
          <p className="text-body text-fg-muted">{t("sharedWithNone")}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="recipe-shares">
            {current.map((share) => (
              <li
                key={share.homeId}
                className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-body font-semibold text-fg">
                    <bdi>{share.homeName}</bdi>
                  </p>
                  <p className="text-helper text-fg-muted">
                    {share.state === "paused"
                      ? t("sharePaused")
                      : share.canEdit
                        ? t("shareCanEdit")
                        : t("shareViewOnly")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {share.state === "paused" ? (
                    <Button
                      size="sm"
                      loading={mutation.busy}
                      onClick={() => {
                        mutation.mutate({ kind: "share", homeId: share.homeId, canEdit: false });
                      }}
                      aria-label={t("reinstateNamed", { home: share.homeName })}
                    >
                      {t("reinstateShare")}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={mutation.busy}
                      onClick={() => {
                        const change: Change = {
                          kind: "share",
                          homeId: share.homeId,
                          canEdit: !share.canEdit,
                        };
                        if (share.canEdit) {
                          mutation.reset();
                          setNarrowing({ change, homeName: share.homeName });
                        } else {
                          mutation.mutate(change);
                        }
                      }}
                      aria-label={
                        share.canEdit
                          ? t("makeViewOnlyNamed", { home: share.homeName })
                          : t("allowEditNamed", { home: share.homeName })
                      }
                    >
                      {share.canEdit ? t("makeViewOnly") : t("allowEdit")}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={mutation.busy}
                    onClick={() => {
                      mutation.reset();
                      setNarrowing({
                        change: { kind: "unshare", homeId: share.homeId },
                        homeName: share.homeName,
                      });
                    }}
                    aria-label={t("removeShareNamed", { home: share.homeName })}
                    data-testid="recipe-remove-share"
                  >
                    {t("removeShare")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="share-with-heading" className="flex flex-col gap-3">
        <h2 id="share-with-heading" className="text-section-title font-semibold text-fg">
          {t("shareWithHeading")}
        </h2>
        {available.length === 0 ? (
          <p className="text-body text-fg-muted">{t("shareNoHomes")}</p>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.reset();
              setTarget(selected);
              setConfirming(true);
            }}
          >
            <SelectField
              label={t("shareHomeLabel")}
              description={t("shareHomeHelp")}
              value={selected}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
              options={available.map((home) => ({ value: home.homeId, label: home.homeName }))}
              data-testid="recipe-share-home"
            />
            <Checkbox
              label={t("shareAllowEditLabel")}
              description={t("shareAllowEditHelp")}
              checked={canEdit}
              onChange={(event) => {
                setCanEdit(event.target.checked);
              }}
            />
            <div>
              <Button type="submit" data-testid="recipe-share-submit">
                {t("shareSubmit")}
              </Button>
            </div>
          </form>
        )}
      </section>
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("shareConfirmTitle", { home: targetName })}
        description={t("shareConfirmBody", { name: recipeName, home: targetName })}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate({ kind: "share", homeId: selected, canEdit });
              }}
              data-testid="recipe-share-confirm"
            >
              {t("shareSubmit")}
            </Button>
          </>
        }
      >
        <ul className="list-disc ps-6 text-body text-fg">
          <li>{t("shareConsequenceAudience", { home: targetName })}</li>
          <li>{canEdit ? t("shareConsequenceEdit") : t("shareConsequenceViewOnly")}</li>
          <li>{t("shareConsequenceSync")}</li>
          <li>{t("shareConsequenceNoOnward")}</li>
        </ul>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </Dialog>
      <Dialog
        open={narrowing !== null}
        onClose={() => {
          setNarrowing(null);
        }}
        title={
          narrowing?.change.kind === "unshare"
            ? t("removeShareTitle", { home: narrowing.homeName })
            : t("viewOnlyTitle", { home: narrowing?.homeName ?? "" })
        }
        description={
          narrowing?.change.kind === "unshare" ? t("removeShareBody") : t("viewOnlyBody")
        }
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setNarrowing(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant={narrowing?.change.kind === "unshare" ? "destructive" : "primary"}
              loading={mutation.busy}
              onClick={() => {
                if (narrowing) mutation.mutate(narrowing.change);
              }}
              data-testid="recipe-narrow-confirm"
            >
              {narrowing?.change.kind === "unshare" ? t("removeShare") : t("makeViewOnly")}
            </Button>
          </>
        }
      >
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </Dialog>
    </div>
  );
}
