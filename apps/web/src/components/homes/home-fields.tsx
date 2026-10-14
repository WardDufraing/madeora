"use client";

import { useTranslations } from "next-intl";
import type { UseFormRegisterReturn } from "react-hook-form";

import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { HOME_NAME_MAX_LENGTH, type HomeFieldError } from "@/homes/schema";

export interface HomeFieldsProps {
  readonly name: UseFormRegisterReturn;
  readonly timeZone: UseFormRegisterReturn;
  readonly nameError: HomeFieldError | undefined;
  readonly timeZoneError: HomeFieldError | undefined;
  /** Every zone to offer, sorted. */
  readonly timeZoneChoices: readonly string[];
}

/** The Home's name and scheduling timezone, shared by Create a Home and Home settings. */
export function HomeFields({
  name,
  timeZone,
  nameError,
  timeZoneError,
  timeZoneChoices,
}: HomeFieldsProps) {
  const t = useTranslations("Homes");
  const nameMessage =
    nameError === "nameRequired"
      ? t("nameRequired")
      : nameError === "nameTooLong"
        ? t("nameTooLong", { max: HOME_NAME_MAX_LENGTH })
        : nameError === "nameInvalid"
          ? t("nameInvalid")
          : undefined;
  return (
    <>
      <TextField
        label={t("nameLabel")}
        description={t("nameHint", { max: HOME_NAME_MAX_LENGTH })}
        required
        autoComplete="off"
        dir="auto"
        maxLength={HOME_NAME_MAX_LENGTH * 2}
        error={nameMessage}
        {...name}
      />
      <div className="flex flex-col gap-1.5">
        <SelectField
          label={t("timeZoneLabel")}
          description={t("timeZoneHint")}
          options={timeZoneChoices.map((zone) => ({
            value: zone,
            label: zone.replaceAll("_", " "),
          }))}
          {...timeZone}
        />
        {timeZoneError ? (
          <p role="alert" className="text-helper text-danger">
            {t("timeZoneInvalid")}
          </p>
        ) : null}
      </div>
    </>
  );
}
