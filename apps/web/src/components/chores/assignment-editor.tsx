"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { CHORE_LIMITS, type AssignmentMode } from "@/chores/schema";
import type { MemberOption } from "@/tasks/format";

export interface AssignmentDraft {
  readonly mode: AssignmentMode;
  /** Membership ids, in rotation order for a rotation. */
  readonly members: readonly string[];
}

export interface AssignmentEditorProps {
  readonly value: AssignmentDraft;
  readonly onChange: (value: AssignmentDraft) => void;
  readonly members: readonly MemberOption[];
  /** Rotation is for recurring chores only. */
  readonly allowRotation: boolean;
  readonly error?: string | undefined;
}

/**
 * Who a chore is for (S20): nobody in particular, fixed members, or a rotation order. The order is
 * a list with move buttons, so it is set with a keyboard as well as a pointer; the preview beside
 * it shows whose turn each next date is.
 */
export function AssignmentEditor({
  value,
  onChange,
  members,
  allowRotation,
  error,
}: AssignmentEditorProps) {
  const t = useTranslations("Chores");
  const name = useId();
  const nameOf = (id: string) => {
    const member = members.find((option) => option.id === id);
    return member?.isSelf ? t("personYou") : (member?.name ?? t("personUnnamed"));
  };
  const outside = members.filter((member) => !value.members.includes(member.id));
  const [adding, setAdding] = useState("");
  const toAdd = outside.some((member) => member.id === adding) ? adding : (outside[0]?.id ?? "");
  const setMode = (mode: AssignmentMode) => {
    // Fixed members and a rotation start from what was chosen; "nobody" keeps nothing.
    onChange({ mode, members: mode === "none" ? [] : value.members });
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...value.members];
    const [member] = next.splice(index, 1);
    if (member) next.splice(index + by, 0, member);
    onChange({ ...value, members: next });
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="chore-assignment-editor">
      <legend className="text-body font-medium text-fg">{t("fieldAssignment")}</legend>
      <RadioOption
        name={name}
        value="none"
        label={t("assignmentNone")}
        checked={value.mode === "none"}
        onChange={() => {
          setMode("none");
        }}
      />
      <RadioOption
        name={name}
        value="fixed"
        label={t("assignmentFixed")}
        description={t("assignmentFixedHelp")}
        checked={value.mode === "fixed"}
        onChange={() => {
          setMode("fixed");
        }}
      />
      {allowRotation ? (
        <RadioOption
          name={name}
          value="rotating"
          label={t("assignmentRotating")}
          description={t("assignmentRotatingHelp")}
          checked={value.mode === "rotating"}
          onChange={() => {
            setMode("rotating");
          }}
        />
      ) : null}
      {value.mode === "fixed" ? (
        <fieldset className="ms-8 flex flex-col gap-1">
          <legend className="sr-only">{t("assignmentFixed")}</legend>
          {members.map((member) => (
            <Checkbox
              key={member.id}
              label={nameOf(member.id)}
              checked={value.members.includes(member.id)}
              disabled={
                !value.members.includes(member.id) && value.members.length >= CHORE_LIMITS.members
              }
              onChange={(event) => {
                onChange({
                  ...value,
                  members: event.target.checked
                    ? [...value.members, member.id]
                    : value.members.filter((id) => id !== member.id),
                });
              }}
            />
          ))}
        </fieldset>
      ) : null}
      {value.mode === "rotating" ? (
        <div className="ms-8 flex flex-col gap-3">
          <p className="text-helper text-fg-muted">{t("rotationOrderHelp")}</p>
          {value.members.length > 0 ? (
            <ol className="flex flex-col gap-2" aria-label={t("rotationOrder")}>
              {value.members.map((id, index) => (
                <li
                  key={id}
                  className="flex flex-wrap items-center gap-2 rounded-card border border-line p-2"
                  data-testid="rotation-member"
                >
                  <span className="min-w-0 flex-1 text-body text-fg">
                    {t("rotationPlace", { number: index + 1 })} <bdi>{nameOf(id)}</bdi>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                    aria-label={t("moveMemberUp", { name: nameOf(id) })}
                  >
                    {t("moveUp")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === value.members.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                    aria-label={t("moveMemberDown", { name: nameOf(id) })}
                  >
                    {t("moveDown")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onChange({
                        ...value,
                        members: value.members.filter((other) => other !== id),
                      });
                    }}
                    aria-label={t("removeMember", { name: nameOf(id) })}
                  >
                    {t("remove")}
                  </Button>
                </li>
              ))}
            </ol>
          ) : null}
          {outside.length > 0 && value.members.length < CHORE_LIMITS.members ? (
            <div className="flex flex-wrap items-end gap-2">
              <SelectField
                label={t("rotationAdd")}
                value={toAdd}
                onChange={(event) => {
                  setAdding(event.target.value);
                }}
                options={outside.map((member) => ({ value: member.id, label: nameOf(member.id) }))}
                data-testid="rotation-add-select"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (toAdd) onChange({ ...value, members: [...value.members, toAdd] });
                }}
                data-testid="rotation-add"
              >
                {t("rotationAddButton")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="text-helper text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
