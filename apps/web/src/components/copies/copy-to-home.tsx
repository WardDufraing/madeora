"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyActionError, requestHomeCopies, type HomeCopyOutcome } from "@/copies/api";
import { endCodeOf, type CopyItemType } from "@/copies/catalogue";

export interface CopyDestination {
  readonly homeId: string;
  readonly name: string;
  readonly mode: "direct" | "approval";
  readonly shared: boolean;
  readonly open: boolean;
}

export interface CopyToHomeProps {
  readonly itemType: CopyItemType;
  readonly itemId: string;
  readonly files: number;
  readonly homes: readonly CopyDestination[];
  /** Where the item lives, to go back. */
  readonly backHref: string;
}

/**
 * "Copy to a Home" (S40 part 2): the person picks Homes one by one, reads that a copy belongs to the
 * Home for good and never synchronizes with the original, confirms, and sees what happened in each
 * Home: copied, being copied, waiting for approval, or why not. Sharing stays a separate action.
 */
export function CopyToHome({ itemType, itemId, files, homes, backHref }: CopyToHomeProps) {
  const t = useTranslations("HomeCopies");
  const router = useRouter();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<readonly HomeCopyOutcome[] | null>(null);
  const nameOf = new Map(homes.map((home) => [home.homeId, home.name]));

  if (results) {
    return (
      <div className="flex flex-col gap-4" data-testid="copy-results">
        <FormAlert tone="info" announce>
          {t("resultIntro")}
        </FormAlert>
        <ul className="flex flex-col gap-2">
          {results.map((row) => (
            <li key={row.homeId} className="text-body" data-testid={`copy-result-${row.outcome}`}>
              <bdi className="font-semibold">{nameOf.get(row.homeId) ?? t("unknownHome")}</bdi>
              {": "}
              {row.outcome === "failed"
                ? t(`endCode.${endCodeOf(row.code)}`)
                : t(`outcome.${row.outcome}`)}
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap gap-x-4 gap-y-2">
          <Link
            href="/settings/privacy/copies"
            className="text-body font-medium text-accent-fg underline"
          >
            {t("myRequestsLink")}
          </Link>
          <Link href={backHref} className="text-body font-medium text-accent-fg underline">
            {t("backToItem")}
          </Link>
        </p>
      </div>
    );
  }

  if (homes.length === 0) {
    return <p className="text-body">{t("noHomes")}</p>;
  }

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length === 0) {
          setMessage(t("chooseRequired"));
          return;
        }
        if (!understood) {
          setMessage(t("understandRequired"));
          return;
        }
        setBusy(true);
        setMessage(null);
        requestHomeCopies({ itemType, itemId, homeIds: [...chosen] })
          .then((outcome) => {
            setResults(outcome);
            router.refresh();
          })
          .catch((error: unknown) => {
            const failure = error instanceof CopyActionError ? error.failure : "failed";
            if (failure === "signedOut") {
              window.location.assign(new URL("/sign-in", window.location.origin));
              return;
            }
            setMessage(
              failure === "notFound"
                ? t("itemUnavailable")
                : failure === "rateLimited"
                  ? t("tooMany")
                  : t("failed"),
            );
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
        <li>{t("explainCopy")}</li>
        <li>{t("explainOriginal")}</li>
        <li>{t("explainNoSync")}</li>
        <li>{t("explainShare")}</li>
        {files > 0 ? <li>{t(`explainFiles.${itemType}`, { count: files })}</li> : null}
      </ul>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold">{t("homesLegend")}</legend>
        {homes.map((home) => (
          <Checkbox
            key={home.homeId}
            label={home.name}
            description={
              home.open
                ? t("homeOpen")
                : [
                    home.mode === "direct" ? t("homeDirect") : t("homeApproval"),
                    home.shared ? t("homeShared") : null,
                  ]
                    .filter(Boolean)
                    .join(" ")
            }
            disabled={home.open || busy}
            checked={chosen.includes(home.homeId)}
            onChange={(event) => {
              const on = event.target.checked;
              setChosen((list) =>
                on ? [...list, home.homeId] : list.filter((id) => id !== home.homeId),
              );
            }}
            data-testid={`copy-home-${home.homeId}`}
          />
        ))}
      </fieldset>
      <Checkbox
        label={t("understand")}
        checked={understood}
        disabled={busy}
        onChange={(event) => {
          setUnderstood(event.target.checked);
        }}
        data-testid="copy-understand"
      />
      {message ? (
        <FormAlert tone="error" announce>
          {message}
        </FormAlert>
      ) : null}
      <Button type="submit" loading={busy} className="self-start" data-testid="copy-submit">
        {t("submit", { count: chosen.length })}
      </Button>
    </form>
  );
}
