"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  approveDisplay,
  checkPairingCode,
  renameDisplay,
  revokeDisplay,
  type PairingReview,
} from "@/displays/api";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameSchema,
  formatPairingCode,
  pairingCodeSchema,
} from "@/displays/schema";
import type { MemberActionError, MemberFailure } from "@/members/manage-api";

/** A display as the manager list shows it; times and device words already formatted. */
export interface HouseholdDisplayView {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly device: string;
  readonly pairedAt: string;
  readonly pairedBy: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

/** Device words for a reviewed tablet (from the Security catalogue, formatted by the page). */
export interface DeviceWords {
  readonly kind: Readonly<Record<string, string>>;
  readonly browser: Readonly<Record<string, string>>;
  readonly platform: Readonly<Record<string, string>>;
}

const codeFormSchema = z.object({ code: pairingCodeSchema });
type CodeInput = z.input<typeof codeFormSchema>;
type CodeOutput = z.output<typeof codeFormSchema>;

const nameFormSchema = z.object({ name: displayNameSchema });
type NameInput = z.input<typeof nameFormSchema>;
type NameOutput = z.output<typeof nameFormSchema>;

/** The pairing failures that have their own, display-specific wording. */
const pairingMessage: Partial<Record<MemberFailure, string>> = {
  invalidCode: "failInvalidCode",
  notFound: "failInvalidCode",
  expired: "failExpired",
  alreadyUsed: "failAlreadyUsed",
  rateLimited: "failRateLimited",
  limitReached: "failLimitReached",
};

function PairingFailure({ failure }: { readonly failure: MemberFailure | null }) {
  const t = useTranslations("Displays");
  if (!failure) return null;
  const key = pairingMessage[failure];
  if (!key) return <MemberFailureAlert failure={failure} />;
  return (
    <FormAlert tone="error" announce>
      {t(key as "failInvalidCode")}
    </FormAlert>
  );
}

/**
 * Pairing a Household Display (S43; spec "Confirmed manager-approved pairing"): the manager types
 * the code the tablet shows, reviews which device asked for it, names it and approves it into this
 * Home. The tablet then turns into this Home's display by itself; nothing of the manager's session
 * reaches it.
 */
function PairDisplayForm({
  homeId,
  words,
  onPaired,
}: {
  readonly homeId: string;
  readonly words: DeviceWords;
  readonly onPaired: (name: string) => void;
}) {
  const t = useTranslations("Displays");
  const hydrated = useHydrated();
  const [review, setReview] = useState<{ code: string; request: PairingReview } | null>(null);
  const codeForm = useForm<CodeInput, unknown, CodeOutput>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: "" },
  });
  const nameForm = useForm<NameInput, unknown, NameOutput>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: { name: "" },
  });
  const check = useMutation<
    { code: string; request: PairingReview },
    MemberActionError,
    CodeOutput
  >({
    mutationFn: async ({ code }) => ({ code, request: await checkPairingCode(homeId, { code }) }),
    onSuccess: (found) => {
      setReview(found);
    },
  });
  const approve = useMutation<string, MemberActionError, NameOutput>({
    mutationFn: async ({ name }) => {
      if (!review) throw new Error("no review");
      await approveDisplay(homeId, { requestId: review.request.id, code: review.code, name });
      return name;
    },
    onSuccess: (name) => {
      setReview(null);
      codeForm.reset({ code: "" });
      nameForm.reset({ name: "" });
      onPaired(name);
    },
  });

  const submitCode = codeForm.handleSubmit((values) => {
    if (!check.isPending) check.mutate(values);
  });
  const submitName = nameForm.handleSubmit((values) => {
    if (!approve.isPending) approve.mutate(values);
  });

  if (!review) {
    return (
      <form
        method="post"
        noValidate
        className="flex flex-col gap-3"
        data-testid="display-code-form"
        onSubmit={(event) => {
          void submitCode(event);
        }}
      >
        <TextField
          label={t("codeLabel")}
          description={t("codeHint")}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          error={codeForm.formState.errors.code ? t("codeInvalid") : undefined}
          {...codeForm.register("code")}
        />
        <PairingFailure failure={check.error?.failure ?? null} />
        <div>
          <Button type="submit" disabled={!hydrated} loading={check.isPending}>
            {t("checkCode")}
          </Button>
        </div>
      </form>
    );
  }

  const request = review.request;
  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-3"
      data-testid="display-approve-form"
      onSubmit={(event) => {
        void submitName(event);
      }}
    >
      <div className="rounded-control border border-line p-3" data-testid="display-review">
        <p className="text-body font-medium text-fg">
          {t("reviewDevice", {
            kind: words.kind[request.deviceKind] ?? words.kind["unknown"] ?? "",
            browser: words.browser[request.browser] ?? words.browser["other"] ?? "",
            platform: words.platform[request.platform] ?? words.platform["other"] ?? "",
          })}
        </p>
        <p className="text-helper text-fg-muted">
          {t("reviewCode", { code: formatPairingCode(review.code) })}
        </p>
        <p className="mt-2 text-helper text-fg-muted">{t("reviewCheck")}</p>
      </div>
      <TextField
        label={t("nameLabel")}
        description={t("nameHint", { max: DISPLAY_NAME_MAX_LENGTH })}
        dir="auto"
        autoComplete="off"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={nameForm.formState.errors.name ? t("nameInvalid") : undefined}
        {...nameForm.register("name")}
      />
      <PairingFailure failure={approve.error?.failure ?? null} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={approve.isPending}>
          {t("approve")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!hydrated || approve.isPending}
          onClick={() => {
            setReview(null);
            approve.reset();
          }}
        >
          {t("cancelReview")}
        </Button>
      </div>
    </form>
  );
}

function RenameDisplayForm({
  homeId,
  display,
  onDone,
}: {
  readonly homeId: string;
  readonly display: HouseholdDisplayView;
  readonly onDone: (saved: boolean) => void;
}) {
  const t = useTranslations("Displays");
  const hydrated = useHydrated();
  const form = useForm<NameInput, unknown, NameOutput>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: { name: display.name },
  });
  const rename = useMutation<undefined, MemberActionError, NameOutput>({
    mutationFn: async ({ name }) => {
      await renameDisplay(homeId, display.id, { name });
      return undefined;
    },
    onSuccess: () => {
      onDone(true);
    },
  });
  const submit = form.handleSubmit((values) => {
    if (!rename.isPending) rename.mutate(values);
  });
  return (
    <form
      method="post"
      noValidate
      className="mt-3 flex w-full flex-col gap-3"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextField
        label={t("renameLabel", { name: display.name })}
        dir="auto"
        autoComplete="off"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={form.formState.errors.name ? t("nameInvalid") : undefined}
        {...form.register("name")}
      />
      <MemberFailureAlert failure={rename.error?.failure ?? null} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="sm" disabled={!hydrated} loading={rename.isPending}>
          {t("saveName")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            onDone(false);
          }}
        >
          {t("cancelRename")}
        </Button>
      </div>
    </form>
  );
}

/**
 * A Home's Household Displays for its managers (S43): pair a new one, see each one's name, status,
 * when and by whom it was paired and when it was last seen, rename it, and revoke it at once when
 * it is lost or replaced. A revoked display goes back to its pairing screen and can be paired again
 * with a new code.
 */
export function HouseholdDisplaysManager({
  homeId,
  displays,
  words,
}: {
  readonly homeId: string;
  readonly displays: readonly HouseholdDisplayView[];
  readonly words: DeviceWords;
}) {
  const t = useTranslations("Displays");
  const router = useRouter();
  const hydrated = useHydrated();
  const [notice, setNotice] = useState<
    { kind: "paired"; name: string } | { kind: "renamed" | "revoked" } | null
  >(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const revoke = useMutation<undefined, MemberActionError, string>({
    mutationFn: async (displayId) => {
      await revokeDisplay(homeId, displayId);
      return undefined;
    },
    onSuccess: () => {
      setNotice({ kind: "revoked" });
      router.refresh();
    },
  });
  const active = displays.filter((display) => display.active);
  const revoked = displays.filter((display) => !display.active);

  return (
    <div className="flex flex-col gap-8" data-testid="household-displays">
      <section aria-labelledby="pair-display-title" className="flex flex-col gap-3">
        <h2 id="pair-display-title" className="text-section-title font-semibold text-fg">
          {t("pairTitle")}
        </h2>
        <ol className="list-decimal ps-5 text-body text-fg-muted">
          <li>{t("pairStep1")}</li>
          <li>{t("pairStep2")}</li>
          <li>{t("pairStep3")}</li>
        </ol>
        <PairDisplayForm
          homeId={homeId}
          words={words}
          onPaired={(name) => {
            setNotice({ kind: "paired", name });
            router.refresh();
          }}
        />
      </section>

      {notice ? (
        <FormAlert tone="success" announce>
          {notice.kind === "paired"
            ? t("pairedNotice", { name: notice.name })
            : notice.kind === "renamed"
              ? t("renamedNotice")
              : t("revokedNotice")}
        </FormAlert>
      ) : null}
      <MemberFailureAlert failure={revoke.error?.failure ?? null} />

      <section aria-labelledby="displays-list-title" className="flex flex-col gap-3">
        <h2 id="displays-list-title" className="text-section-title font-semibold text-fg">
          {t("listTitle")}
        </h2>
        {active.length === 0 ? (
          <p className="text-body text-fg-muted">{t("listEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {active.map((display) => (
              <li
                key={display.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3"
                data-testid="display-row"
              >
                <div className="flex flex-col">
                  <span className="text-body font-medium text-fg">
                    <bdi>{display.name}</bdi>
                  </span>
                  <span className="text-helper text-fg-muted">{display.device}</span>
                  <span className="text-helper text-fg-muted">
                    {t("pairedOn", {
                      time: display.pairedAt,
                      name: display.pairedBy ?? t("formerMember"),
                    })}
                    {" · "}
                    {display.lastSeenAt
                      ? t("lastSeen", { time: display.lastSeenAt })
                      : t("neverSeen")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/homes/${encodeURIComponent(homeId)}/displays/${encodeURIComponent(display.id)}`}
                    className="text-body font-medium text-accent-fg underline"
                    aria-label={t("configureNamed", { name: display.name })}
                  >
                    {t("configure")}
                  </Link>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!hydrated}
                    aria-label={t("renameNamed", { name: display.name })}
                    onClick={() => {
                      setNotice(null);
                      setRenaming(renaming === display.id ? null : display.id);
                    }}
                  >
                    {t("rename")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!hydrated || revoke.isPending}
                    aria-label={t("revokeNamed", { name: display.name })}
                    onClick={() => {
                      setNotice(null);
                      revoke.mutate(display.id);
                    }}
                  >
                    {t("revoke")}
                  </Button>
                </div>
                {renaming === display.id ? (
                  <RenameDisplayForm
                    homeId={homeId}
                    display={display}
                    onDone={(saved) => {
                      setRenaming(null);
                      if (saved) {
                        setNotice({ kind: "renamed" });
                        router.refresh();
                      }
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 ? (
          <>
            <h3 className="mt-2 text-body font-semibold text-fg">{t("revokedTitle")}</h3>
            <ul className="flex flex-col gap-2">
              {revoked.map((display) => (
                <li key={display.id} className="text-helper text-fg-muted">
                  <bdi className="font-medium text-fg">{display.name}</bdi>
                  {" · "}
                  {display.revokedAt
                    ? t("revokedOn", { time: display.revokedAt })
                    : t("revokedNoDate")}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
