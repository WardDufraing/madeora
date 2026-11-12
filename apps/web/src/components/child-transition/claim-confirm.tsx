"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { completeClaim, type ClaimFailure } from "@/child-transition/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useHydrated } from "@/components/ui/use-hydrated";

/**
 * The young person's express confirmation (S42 part 3), from the link sent to their own address.
 * Once confirmed they choose a password through the password-reset email.
 */
export function ClaimConfirm({
  token,
  email,
  alreadyDone = false,
}: {
  readonly token: string;
  readonly email: string | null;
  readonly alreadyDone?: boolean;
}) {
  const t = useTranslations("ChildTransition");
  const hydrated = useHydrated();
  const [agreed, setAgreed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(alreadyDone);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);

  if (done) {
    return (
      <div className="flex flex-col gap-4" data-testid="claim-done">
        <FormAlert tone="success" announce>
          {t("completed")}
        </FormAlert>
        <p className="text-body text-fg">
          {email ? t("choosePasswordFor", { email }) : t("choosePassword")}
        </p>
        <p>
          <Link href="/forgot-password" className="font-medium text-accent-fg underline">
            {t("choosePasswordLink")}
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (!agreed) {
          setMissing(true);
          return;
        }
        setPending(true);
        setFailure(null);
        void completeClaim(token).then((result) => {
          setPending(false);
          if (result === null) setDone(true);
          else setFailure(result);
        });
      }}
    >
      <Checkbox
        label={t("agree")}
        checked={agreed}
        {...(missing && !agreed ? { error: t("agreeRequired") } : {})}
        onChange={(event) => {
          setAgreed(event.target.checked);
        }}
      />
      {failure ? (
        <FormAlert tone="error" announce>
          {t(`fail.${failure}`)}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" disabled={!hydrated} loading={pending}>
          {t("confirm")}
        </Button>
      </div>
    </form>
  );
}
