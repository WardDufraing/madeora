"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { nameProblem, normalizeName } from "@/names/visible-name";
import { RECIPE_FIELD_LIMITS, tagKey } from "@/recipes/schema";

export interface TagsFieldProps {
  readonly value: readonly string[];
  readonly onChange: (tags: string[]) => void;
  readonly error?: string | undefined;
}

/**
 * The recipe's manual tags (S24): type one and press Enter or Add; each is a chip with its own
 * Remove button. The same tag twice (whatever its case or accents) is refused; at most 20 of 40
 * characters each.
 */
export function TagsField({ value, onChange, error }: TagsFieldProps) {
  const t = useTranslations("Recipes");
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function add() {
    const tag = normalizeName(text);
    if (tag === "") return;
    const issue = nameProblem(tag, RECIPE_FIELD_LIMITS.tag);
    if (issue) {
      setProblem(issue === "tooLong" ? t("fieldTooLong") : t("fieldInvalidCharacters"));
      return;
    }
    if (value.some((existing) => tagKey(existing) === tagKey(tag))) {
      setProblem(t("tagDuplicate"));
      return;
    }
    if (value.length >= RECIPE_FIELD_LIMITS.tags) {
      setProblem(t("tagsTooMany", { max: RECIPE_FIELD_LIMITS.tags }));
      return;
    }
    onChange([...value, tag]);
    setText("");
    setProblem(null);
  }

  const message = problem ?? error;
  return (
    <div className="flex flex-col gap-2" data-testid="tags-field">
      <label htmlFor={`${id}-input`} className="text-body font-medium text-fg">
        {t("tagsLabel")}
      </label>
      <p id={`${id}-help`} className="text-helper text-fg-muted">
        {t("tagsHelp")}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${id}-input`}
          value={text}
          maxLength={RECIPE_FIELD_LIMITS.tag * 2}
          autoComplete="off"
          aria-describedby={message ? `${id}-help ${id}-error` : `${id}-help`}
          aria-invalid={message ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="min-h-10 min-w-0 flex-1 rounded-control border border-line-control bg-surface px-3 text-body text-fg"
        />
        <Button variant="secondary" onClick={add}>
          {t("addTag")}
        </Button>
      </div>
      {message ? (
        <p id={`${id}-error`} className="text-helper text-danger">
          {message}
        </p>
      ) : null}
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("tagsChosen")}>
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-surface-sunken ps-3 text-helper text-fg"
            >
              <bdi>{tag}</bdi>
              <button
                type="button"
                onClick={() => {
                  onChange(value.filter((existing) => existing !== tag));
                }}
                className="inline-flex size-8 items-center justify-center rounded-full text-fg-muted hover:bg-accent-subtle"
                aria-label={t("removeTag", { tag })}
              >
                <span aria-hidden="true">{"×"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
