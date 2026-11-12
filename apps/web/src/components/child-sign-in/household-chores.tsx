"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  completeChoreOnDevice,
  undoChoreOnDevice,
  type DeviceChoreDone,
  type DeviceChoreFailure,
} from "@/child-sign-in/api";
import { PIN_MAX_LENGTH } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

export interface HouseholdChoreMember {
  readonly membershipId: string;
  readonly name: string | null;
  readonly accentColor: string | null;
  readonly isChild: boolean;
  readonly hasPin: boolean;
  readonly requiresPin: boolean;
}

export interface HouseholdChore {
  readonly occurrenceId: string;
  readonly title: string;
  readonly dueLabel: string;
  readonly overdue: boolean;
  readonly assigneeIds: readonly string[];
  readonly mandatoryOpen: number;
  readonly requiresApproval: boolean;
  readonly requiresPin: boolean;
}

const UNDO_MS = 2 * 60 * 1000;

/**
 * Chores on an approved household device (S42 part 2): pick a chore, answer "Who completed
 * this?", see the person and the chore together, confirm (with a PIN when the Home requires one,
 * or by choice), and Undo for two minutes. Nothing about the person is kept for the next one:
 * after each action the screen goes back to the list. The server checks everything again.
 */
export function HouseholdChores({
  requirePin,
  members,
  chores,
}: {
  readonly requirePin: boolean;
  readonly members: readonly HouseholdChoreMember[];
  readonly chores: readonly HouseholdChore[];
}) {
  const t = useTranslations("HouseholdChores");
  const router = useRouter();
  const hydrated = useHydrated();
  const [chore, setChore] = useState<HouseholdChore | null>(null);
  const [member, setMember] = useState<HouseholdChoreMember | null>(null);
  const [usePin, setUsePin] = useState(false);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<DeviceChoreFailure | null>(null);
  const [done, setDone] = useState<(DeviceChoreDone & { readonly chore: string }) | null>(null);
  const [undone, setUndone] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  // The Undo offer ends after two minutes, as on the server.
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => {
      setDone(null);
    }, UNDO_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [done]);

  const reset = () => {
    setChore(null);
    setMember(null);
    setUsePin(false);
    setPin("");
    setFailure(null);
  };

  const nameOf = (person: HouseholdChoreMember) => person.name ?? t("unnamed");

  if (done) {
    return (
      <div className="flex flex-col gap-4" data-testid="household-chore-done">
        <FormAlert tone="success" announce>
          {undone
            ? t("undone", { chore: done.chore })
            : done.outcome === "submitted"
              ? t("submitted", { chore: done.chore })
              : t("completed", { chore: done.chore })}
        </FormAlert>
        <div className="flex flex-wrap gap-3">
          {undone ? null : (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setPending(true);
                void undoChoreOnDevice(done.actionId).then((ok) => {
                  setPending(false);
                  if (ok) {
                    setUndone(true);
                    router.refresh();
                  } else setFailure({ kind: "failed" });
                });
              }}
            >
              {t("undo")}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => {
              setDone(null);
              setUndone(false);
              reset();
            }}
          >
            {t("done")}
          </Button>
        </div>
        {failure ? <FormAlert tone="error">{t("undoFailed")}</FormAlert> : null}
      </div>
    );
  }

  if (!chore) {
    if (chores.length === 0) {
      return <p className="text-body text-fg">{t("noChores")}</p>;
    }
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-section-title font-semibold text-fg">{t("pickChore")}</h2>
        <ul className="flex flex-col gap-3" data-testid="household-chore-list">
          {chores.map((item) => (
            <li key={item.occurrenceId}>
              <button
                type="button"
                className="flex min-h-14 w-full flex-col items-start gap-1 rounded-control border border-line bg-surface px-4 py-3 text-start hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                disabled={!hydrated}
                onClick={() => {
                  reset();
                  setChore(item);
                }}
              >
                <span className="text-body font-medium text-fg" dir="auto">
                  {item.title}
                </span>
                <span className="text-helper text-fg-muted">
                  {item.overdue ? t("overdue", { date: item.dueLabel }) : t("dueToday")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Children may only be named for a chore assigned to them (the server checks this too).
  const eligible = members.filter(
    (person) => !person.isChild || chore.assigneeIds.includes(person.membershipId),
  );

  if (!member) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body text-fg">
          <bdi className="font-semibold">{chore.title}</bdi>
        </p>
        <h2 className="text-section-title font-semibold text-fg">{t("whoCompleted")}</h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="household-chore-members">
          {eligible.map((person) => (
            <li key={person.membershipId}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-3 text-start text-body font-medium text-fg hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                onClick={() => {
                  setFailure(null);
                  setPin("");
                  setUsePin(false);
                  setMember(person);
                }}
              >
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full border border-line"
                  style={person.accentColor ? { backgroundColor: person.accentColor } : undefined}
                />
                <bdi>{nameOf(person)}</bdi>
              </button>
            </li>
          ))}
        </ul>
        <div>
          <Button type="button" variant="secondary" onClick={reset}>
            {t("back")}
          </Button>
        </div>
      </div>
    );
  }

  // The stricter rule wins: the Home's, this person's or this chore's (spec).
  const pinRequired = requirePin || member.requiresPin || chore.requiresPin;
  const pinNeeded = pinRequired || usePin;
  const failureText = (value: DeviceChoreFailure): string => {
    switch (value.kind) {
      case "locked":
        return value.until === null ? t("fail.lockedGuardian") : t("fail.locked");
      case "invalidPin":
        return t("fail.invalidPin");
      case "pinRequired":
        return t("fail.pinRequired");
      case "pinNotSet":
        return t("fail.pinNotSet");
      case "alreadyDone":
        return t("fail.alreadyDone");
      case "stepsIncomplete":
        return t("fail.stepsIncomplete");
      case "notEligible":
        return t("fail.notEligible");
      case "deviceNotApproved":
        return t("fail.deviceNotApproved");
      case "rateLimited":
        return t("fail.rateLimited");
      case "network":
        return t("fail.network");
      case "failed":
        return t("fail.failed");
    }
  };

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="household-chore-confirm"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (pinNeeded && !/^\d{4,8}$/.test(pin)) {
          setFailure({ kind: "invalidPin" });
          return;
        }
        setPending(true);
        setFailure(null);
        void completeChoreOnDevice({
          occurrenceId: chore.occurrenceId,
          membershipId: member.membershipId,
          pin: pinNeeded ? pin : null,
        }).then((result) => {
          setPin("");
          setPending(false);
          if ("actionId" in result) {
            setDone({ ...result, chore: chore.title });
            setUndone(false);
            setFailure(null);
            setChore(null);
            setMember(null);
            router.refresh();
            return;
          }
          setFailure(result);
          pinRef.current?.focus();
        });
      }}
    >
      <p className="text-body text-fg" data-testid="household-chore-summary">
        {t("confirmLine", { name: nameOf(member), chore: chore.title })}
      </p>
      {chore.mandatoryOpen > 0 ? (
        <p className="text-helper text-fg-muted">
          {t("stepsOpen", { count: chore.mandatoryOpen })}
        </p>
      ) : null}
      {chore.requiresApproval ? (
        <p className="text-helper text-fg-muted">{t("needsApproval")}</p>
      ) : null}
      {pinRequired ? (
        <p className="text-helper text-fg-muted">
          {requirePin
            ? t("pinRequiredHere")
            : chore.requiresPin
              ? t("pinRequiredChore")
              : t("pinRequiredMember", { name: nameOf(member) })}
        </p>
      ) : member.hasPin ? (
        <Checkbox
          label={t("confirmWithPin")}
          checked={usePin}
          onChange={(event) => {
            setUsePin(event.target.checked);
            setPin("");
          }}
        />
      ) : null}
      {pinNeeded ? (
        <TextField
          ref={(element) => {
            pinRef.current = element;
            focusOnMount(element);
          }}
          label={t("pinLabel", { name: nameOf(member) })}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={PIN_MAX_LENGTH}
          value={pin}
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, ""));
          }}
        />
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          {failureText(failure)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={pending}>
          {t("confirm")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setPin("");
            setFailure(null);
            setMember(null);
          }}
        >
          {t("notMe")}
        </Button>
      </div>
    </form>
  );
}
