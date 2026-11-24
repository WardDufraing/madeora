"use client";

import { CheckIcon, PlusIcon, SearchIcon } from "@madeora/icons";
import { useId, useState, useSyncExternalStore } from "react";

import { cx } from "./cx";
import { Popover } from "./popover";

export interface SwitcherItem {
  /** Stable id (a list or folder id), never the display name. */
  readonly id: string;
  readonly label: string;
}

export interface AdaptiveSwitcherProps {
  /** Names the group, e.g. "Task lists" (translated by the caller). */
  readonly label: string;
  readonly items: readonly SwitcherItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** "+ New list". Shown in chips and in the picker; omit when the person may not create. */
  readonly createLabel?: string;
  readonly onCreate?: () => void;
  /** Up to this many items show as chips; more switch to the searchable picker. Default 5. */
  readonly chipLimit?: number;
  readonly searchLabel: string;
  readonly noResultsLabel: string;
  /** Picker button name, e.g. "Choose list" (translated by the caller). */
  readonly pickerLabel: string;
  readonly className?: string;
}

const NARROW = "(max-width: 40rem)";

function subscribeNarrow(callback: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", callback);
  return () => {
    query.removeEventListener("change", callback);
  };
}

/**
 * Switches between a few frequently used lists, folders or similar (redesign decisions 54, 59, 71):
 * compact chips while there are only a few and room, a searchable picker when there are many
 * items or on a narrow screen. The selected item is marked with a check and `aria-pressed`, not
 * by colour alone. The same component serves Tasks and Shopping.
 */
export function AdaptiveSwitcher({
  label,
  items,
  value,
  onChange,
  createLabel,
  onCreate,
  chipLimit = 5,
  searchLabel,
  noResultsLabel,
  pickerLabel,
  className,
}: AdaptiveSwitcherProps) {
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
  const asPicker = narrow || items.length > chipLimit;
  const selected = items.find((item) => item.id === value);

  const create =
    createLabel && onCreate ? (
      <button
        type="button"
        onClick={onCreate}
        className="press-feedback inline-flex min-h-10 items-center gap-1.5 rounded-control border border-dashed border-line-control px-3 text-body text-fg hover:bg-accent-subtle"
      >
        <PlusIcon size="sm" />
        {createLabel}
      </button>
    ) : null;

  if (!asPicker) {
    return (
      <div
        role="group"
        aria-label={label}
        className={cx("flex flex-wrap items-center gap-2", className)}
      >
        {items.map((item) => {
          const active = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                onChange(item.id);
              }}
              className={cx(
                "press-feedback inline-flex min-h-10 max-w-48 items-center gap-1.5 rounded-control border px-3 text-body",
                active
                  ? "border-accent-edge bg-accent-subtle font-semibold text-fg shadow-selected"
                  : "border-line-control bg-surface text-fg hover:bg-accent-subtle",
              )}
            >
              {active ? <CheckIcon size="sm" className="shrink-0" /> : null}
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
        {create}
      </div>
    );
  }

  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      <Popover
        label={pickerLabel}
        trigger={
          <span className="max-w-48 truncate font-semibold">{selected?.label ?? label}</span>
        }
        triggerClassName="border border-line-control bg-surface shadow-raised"
        panelClassName="w-72"
      >
        {(close) => (
          <Picker
            items={items}
            value={value}
            searchLabel={searchLabel}
            noResultsLabel={noResultsLabel}
            label={label}
            onPick={(id) => {
              onChange(id);
              close();
            }}
          />
        )}
      </Popover>
      {create}
    </div>
  );
}

function Picker({
  items,
  value,
  label,
  searchLabel,
  noResultsLabel,
  onPick,
}: {
  readonly items: readonly SwitcherItem[];
  readonly value: string;
  readonly label: string;
  readonly searchLabel: string;
  readonly noResultsLabel: string;
  readonly onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? items.filter((item) => item.label.toLocaleLowerCase().includes(needle))
    : items;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="sr-only">
        {searchLabel}
      </label>
      <div className="relative">
        <SearchIcon
          size="sm"
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-fg-muted"
        />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={searchLabel}
          className="min-h-10 w-full rounded-control border border-line-control bg-surface ps-9 pe-3 text-body text-fg shadow-inset"
        />
      </div>
      {shown.length === 0 ? (
        <p role="status" className="px-1 py-2 text-helper text-fg-muted">
          {noResultsLabel}
        </p>
      ) : (
        <ul aria-label={label} className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {shown.map((item) => {
            const active = item.id === value;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onPick(item.id);
                  }}
                  className={cx(
                    "flex min-h-10 w-full items-center gap-2 rounded-control px-3 text-start text-body hover:bg-accent-subtle",
                    active && "bg-accent-subtle font-semibold",
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center">
                    {active ? <CheckIcon size="sm" /> : null}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
