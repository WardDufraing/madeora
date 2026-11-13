"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { PIN_MAX_LENGTH } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { TextField } from "@/components/ui/text-field";
import { lockThisDisplay, type DisplayLockFailure } from "@/displays/api";

export interface DisplayLockManager {
  readonly membershipId: string;
  readonly name: string | null;
  readonly accentColor: string | null;
}

/**
 * Locking the display into privacy/party mode on the display itself (S44): one of the Home's
 * managers picks themselves and confirms with their own household-device PIN. Nothing here
 * unlocks: that needs a manager's own session. The PIN is cleared after every try and when the
 * dialog closes.
 */
export function DisplayLockDialog({
  open,
  managers,
  onClose,
  onLocked,
}: {
  readonly open: boolean;
  readonly managers: readonly DisplayLockManager[];
  readonly onClose: () => void;
  readonly onLocked: () => void;
}) {
  const t = useTranslations("DisplayBoard");
  const [manager, setManager] = useState<DisplayLockManager | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<DisplayLockFailure | null>(null);

  const close = () => {
    setManager(null);
    setPin("");
    setFailure(null);
    onClose();
  };
  const nameOf = (person: DisplayLockManager) => person.name ?? t("unnamed");

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("lockTitle")}
      description={t("lockDescription")}
      closeLabel={t("close")}
    >
      {!manager ? (
        <ul className="flex flex-col gap-3" data-testid="display-lock-managers">
          {managers.map((person) => (
            <li key={person.membershipId}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-3 text-start text-body font-medium text-fg hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                onClick={() => {
                  setFailure(null);
                  setPin("");
                  setManager(person);
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
      ) : (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            if (!/^\d{4,8}$/.test(pin)) {
              setFailure("invalidPin");
              return;
            }
            setPending(true);
            setFailure(null);
            void lockThisDisplay({ membershipId: manager.membershipId, pin }).then((result) => {
              setPin("");
              setPending(false);
              if (result === null) {
                setManager(null);
                onLocked();
                return;
              }
              setFailure(result);
            });
          }}
        >
          <TextField
            ref={focusOnMount}
            label={t("pinLabel", { name: nameOf(manager) })}
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
              {t(`lockFail.${failure}`)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={pending}>
              {t("lockConfirm")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setPin("");
                setFailure(null);
                setManager(null);
              }}
            >
              {t("notMe")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
