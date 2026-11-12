"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { CHILD_HOME_PATH } from "@/auth/redirects";
import { signInChildWithPin, type ChildSignInFailure } from "@/child-sign-in/api";
import { PIN_MAX_LENGTH } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { ChildSignInFailureText } from "./child-sign-in-failure";

export interface HouseholdChild {
  readonly membershipId: string;
  readonly name: string;
  readonly accentColor: string | null;
}

/**
 * PIN sign-in on an approved household device (S42): the child taps their own name, sees it
 * confirmed, and types their PIN. Choosing a name grants nothing by itself; the PIN is checked on
 * the server and cleared after every try, and "Not me" goes back without keeping anything.
 */
export function HouseholdPinSignIn({
  childrenOfHome,
}: {
  readonly childrenOfHome: readonly HouseholdChild[];
}) {
  const t = useTranslations("ChildSignIn");
  const hydrated = useHydrated();
  const [selected, setSelected] = useState<HouseholdChild | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ChildSignInFailure | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  if (!selected) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-section-title font-semibold text-fg">{t("whoAreYou")}</h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="household-children">
          {childrenOfHome.map((child) => (
            <li key={child.membershipId}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-3 text-start text-body font-medium text-fg hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                disabled={!hydrated}
                onClick={() => {
                  setFailure(null);
                  setPin("");
                  setSelected(child);
                }}
              >
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full border border-line"
                  style={child.accentColor ? { backgroundColor: child.accentColor } : undefined}
                />
                <bdi>{child.name}</bdi>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="household-pin-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !/^\d{4,8}$/.test(pin)) {
          if (!pending) setFailure({ kind: "invalidCredentials" });
          return;
        }
        setPending(true);
        setFailure(null);
        void signInChildWithPin({ childMembershipId: selected.membershipId, pin }).then(
          (result) => {
            setPin("");
            if (result) {
              setFailure(result);
              setPending(false);
              pinRef.current?.focus();
              return;
            }
            window.location.assign(new URL(CHILD_HOME_PATH, window.location.origin));
          },
        );
      }}
    >
      <p className="text-body text-fg">{t("signingInAs", { name: selected.name })}</p>
      <TextField
        ref={(element) => {
          // The child just chose their name, so the PIN field takes focus (not on page load).
          pinRef.current = element;
          focusOnMount(element);
        }}
        label={t("pinEntryLabel")}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={PIN_MAX_LENGTH}
        value={pin}
        onChange={(event) => {
          setPin(event.target.value.replace(/\D/g, ""));
        }}
      />
      {failure ? (
        <FormAlert tone="error" announce>
          <ChildSignInFailureText failure={failure} />
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={pending}>
          {t("signInButton")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setPin("");
            setFailure(null);
            setSelected(null);
          }}
        >
          {t("notMe")}
        </Button>
      </div>
    </form>
  );
}
