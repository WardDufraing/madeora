"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { MEAL_LIMITS } from "@madeora/domain/meals";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  MEAL_SETTINGS_ENDPOINT,
  MEAL_SLOTS_ENDPOINT,
  mealSlotEndpoint,
  sendMealRequest,
  type MealPlan,
  type MealSlot,
  type MealSlotImpact,
} from "@/meals/api";
import { newId } from "@/meals/format";
import { slotNameSchema } from "@/meals/schema";

import { useMealPlan } from "./meal-planner";
import { useMealMutation } from "./use-meal-mutation";
import { useMealTexts } from "./use-meal-texts";

export interface MealSettingsProps {
  readonly homeId: string | null;
  readonly context: string;
  readonly plan: MealPlan;
}

/**
 * The planner's slots and settings (S27). Meal managers (the Personal space's owner; a Home's Owner
 * and Administrators with the capability) add, rename, reorder (Move up/down), disable and
 * re-enable slots, and set whether a Home's members plan meals or only see the plan. Disabling a
 * slot that holds meals first shows what it affects; nothing is deleted or moved. Everyone else
 * sees the slots.
 */
export function MealSettings({ homeId, context, plan: initialPlan }: MealSettingsProps) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const plan = useMealPlan(homeId, initialPlan);
  const manage = plan.access === "manage";
  const slots = [...plan.slots].sort((a, b) => a.position - b.position);
  const [editing, setEditing] = useState<MealSlot | null>(null);
  const [disabling, setDisabling] = useState<MealSlot | null>(null);
  const [adding, setAdding] = useState(false);
  const move = useMealMutation(
    "meal-slots-order",
    ({ slot, direction }: { slot: MealSlot; direction: "up" | "down" }) =>
      sendMealRequest("POST", mealSlotEndpoint(slot.id, "move"), { direction }),
  );
  const enable = useMealMutation("meal-slots-enable", (slot: MealSlot) =>
    sendMealRequest("PATCH", mealSlotEndpoint(slot.id), {
      revision: slot.revision,
      name: slot.name,
      enabled: true,
    }),
  );
  const failure = move.error ?? enable.error;

  return (
    <div className="flex flex-col gap-6" data-testid="meal-settings">
      <p className="text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{context}</bdi>
      </p>
      <section aria-labelledby="meal-slots-heading" className="flex flex-col gap-3">
        <h2 id="meal-slots-heading" className="text-section-title font-semibold">
          {t("slotsTitle")}
        </h2>
        <p className="text-helper text-fg-muted">
          {manage ? t("slotsExplanation", { max: MEAL_LIMITS.slots }) : t("slotsReadOnly")}
        </p>
        <ol className="flex flex-col gap-2" data-testid="meal-slot-list">
          {slots.map((slot, index) => {
            const name = texts.slotName(slot);
            return (
              <li
                key={slot.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-3"
              >
                <span className="text-body text-fg">
                  <bdi className="font-medium">{name}</bdi>
                  {!slot.enabled ? (
                    <span className="text-helper text-fg-muted">
                      {" "}
                      {"\u{00B7}"} {t("slotDisabled")}
                    </span>
                  ) : null}
                </span>
                {manage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === 0}
                      aria-label={t("moveUpSlot", { slot: name })}
                      loading={
                        move.busy &&
                        move.variables?.slot.id === slot.id &&
                        move.variables.direction === "up"
                      }
                      onClick={() => {
                        move.mutate({ slot, direction: "up" });
                      }}
                    >
                      {t("moveUp")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === slots.length - 1}
                      aria-label={t("moveDownSlot", { slot: name })}
                      loading={
                        move.busy &&
                        move.variables?.slot.id === slot.id &&
                        move.variables.direction === "down"
                      }
                      onClick={() => {
                        move.mutate({ slot, direction: "down" });
                      }}
                    >
                      {t("moveDown")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("renameSlot", { slot: name })}
                      onClick={() => {
                        setEditing(slot);
                      }}
                    >
                      {t("rename")}
                    </Button>
                    {slot.enabled ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t("disableSlot", { slot: name })}
                        onClick={() => {
                          setDisabling(slot);
                        }}
                        data-testid="meal-slot-disable"
                      >
                        {t("disable")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t("enableSlot", { slot: name })}
                        loading={enable.busy && enable.variables?.id === slot.id}
                        onClick={() => {
                          enable.mutate(slot);
                        }}
                        data-testid="meal-slot-enable"
                      >
                        {t("enable")}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {failure ? (
          <FormAlert tone="error" announce>
            {texts.failure(failure.failure)}
          </FormAlert>
        ) : null}
        {manage ? (
          <div>
            <Button
              variant="secondary"
              disabled={slots.length >= MEAL_LIMITS.slots}
              onClick={() => {
                setAdding(true);
              }}
              data-testid="meal-slot-add"
            >
              {t("addSlot")}
            </Button>
          </div>
        ) : null}
      </section>
      {homeId && manage ? <MemberAccess homeId={homeId} plan={plan} /> : null}
      {homeId && !manage ? (
        <p className="text-body text-fg-muted">
          {plan.memberAccess === "edit" ? t("membersPlan") : t("membersView")}
        </p>
      ) : null}
      {editing || adding ? (
        <SlotNameDialog
          slot={editing}
          homeId={homeId}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
        />
      ) : null}
      {disabling ? (
        <DisableSlotDialog
          slot={disabling}
          onClose={() => {
            setDisabling(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Adds a slot, or renames one (a standard slot can go back to its standard name). */
function SlotNameDialog({
  slot,
  homeId,
  onClose,
}: {
  readonly slot: MealSlot | null;
  readonly homeId: string | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const [name, setName] = useState(slot ? texts.slotName(slot) : "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [id] = useState(newId);
  const save = useMealMutation(
    `meal-slot:${slot?.id ?? id}`,
    (value: string | null) =>
      slot
        ? sendMealRequest("PATCH", mealSlotEndpoint(slot.id), {
            revision: slot.revision,
            name: value,
            enabled: slot.enabled,
          })
        : sendMealRequest("POST", MEAL_SLOTS_ENDPOINT, { id, homeId, name: value }),
    onClose,
  );
  const submit = (value: string | null) => {
    if (value !== null) {
      const parsed = slotNameSchema.safeParse(value);
      if (!parsed.success) {
        setError(texts.field(parsed.error.issues[0]?.message));
        return;
      }
    }
    setError(undefined);
    save.mutate(value);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={slot ? t("renameSlotTitle") : t("addSlotTitle")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          // An unchanged standard name stays the translated one.
          submit(slot && slot.name === null && name === texts.slotName(slot) ? null : name);
        }}
      >
        <TextField
          label={t("fieldSlotName")}
          value={name}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={error}
          data-testid="meal-slot-name"
        />
        {save.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(save.error.failure)}
          </FormAlert>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {slot?.standardKey && slot.name !== null ? (
            <Button
              variant="ghost"
              onClick={() => {
                submit(null);
              }}
            >
              {t("standardName")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="meal-slot-save">
            {t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Disabling a slot: what it affects first (asked again if it changed), then a confirmation. */
function DisableSlotDialog({
  slot,
  onClose,
}: {
  readonly slot: MealSlot;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const toast = useToast();
  const [impact, setImpact] = useState<MealSlotImpact | null>(null);
  const disable = useMealMutation(
    `meal-slot:${slot.id}`,
    (token: string | null) =>
      sendMealRequest("PATCH", mealSlotEndpoint(slot.id), {
        revision: slot.revision,
        name: slot.name,
        enabled: false,
        impactToken: token,
      }),
    () => {
      onClose();
      toast.show({ title: t("slotDisabledDone", { slot: texts.slotName(slot) }), tone: "success" });
    },
  );
  const send = (token: string | null) => {
    disable.mutate(token, {
      onError: (error) => {
        if (error.failure === "impactRequired" && error.details.impact) {
          setImpact(error.details.impact);
          disable.reset();
        }
      },
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("disableSlotTitle", { slot: texts.slotName(slot) })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-3" data-testid="meal-slot-impact">
        {impact ? (
          <ul className="list-disc ps-5 text-body text-fg">
            <li>{t("impactFuture", { count: impact.futureMeals })}</li>
            <li>{t("impactPast", { count: impact.pastMeals })}</li>
            <li>{t("impactSeries", { count: impact.series })}</li>
          </ul>
        ) : null}
        <p className="text-helper text-fg-muted">{t("disableExplanation")}</p>
        {disable.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(disable.error.failure)}
          </FormAlert>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={disable.busy}
            onClick={() => {
              send(impact?.token ?? null);
            }}
            data-testid="meal-slot-disable-confirm"
          >
            {t("disable")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Whether a Home's members plan meals or only see the plan (meal managers). */
function MemberAccess({ homeId, plan }: { readonly homeId: string; readonly plan: MealPlan }) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const toast = useToast();
  const [value, setValue] = useState<"edit" | "view">(plan.memberAccess);
  const save = useMealMutation(
    `meal-settings:${homeId}`,
    (memberAccess: "edit" | "view") =>
      sendMealRequest("PATCH", MEAL_SETTINGS_ENDPOINT, {
        homeId,
        revision: plan.settingsRevision,
        memberAccess,
      }),
    () => {
      toast.show({ title: t("settingsSaved"), tone: "success" });
    },
  );
  return (
    <section aria-labelledby="meal-access-heading" className="flex flex-col gap-3">
      <h2 id="meal-access-heading" className="text-section-title font-semibold">
        {t("accessTitle")}
      </h2>
      <form
        noValidate
        className="flex flex-col gap-3 sm:max-w-md"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(value);
        }}
      >
        <SelectField
          label={t("fieldMemberAccess")}
          description={t("fieldMemberAccessHint")}
          value={value}
          onChange={(event) => {
            setValue(event.target.value === "view" ? "view" : "edit");
          }}
          options={[
            { value: "edit", label: t("memberAccessEdit") },
            { value: "view", label: t("memberAccessView") },
          ]}
          data-testid="meal-member-access"
        />
        {save.error ? (
          <FormAlert tone="error" announce>
            {save.error.failure === "conflict"
              ? t("settingsChangedMeanwhile")
              : texts.failure(save.error.failure)}
          </FormAlert>
        ) : null}
        <div>
          <Button type="submit" loading={save.busy}>
            {t("save")}
          </Button>
        </div>
      </form>
    </section>
  );
}
