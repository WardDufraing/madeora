"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { cx } from "@/components/ui/cx";

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
}

export interface SettingsLayoutProps {
  readonly sections: readonly SettingsSection[];
  readonly children: ReactNode;
}

/** Other anchors on the page that belong to one of the groups. */
const aliases: Readonly<Record<string, string>> = { "sign-in-methods": "security" };

function hashId(): string | null {
  const raw = window.location.hash.slice(1);
  if (raw === "") return null;
  try {
    const id = decodeURIComponent(raw);
    return aliases[id] ?? id;
  } catch {
    return null;
  }
}

/**
 * Two columns on wide screens: a sticky list of sections on the start side and the grouped cards
 * beside it. On narrow screens the list becomes a labelled dropdown. Both only jump to a section
 * on the same page, so the page works the same with them as without.
 */
export function SettingsLayout({ sections, children }: SettingsLayoutProps) {
  const t = useTranslations("Settings");
  // Nothing is marked current until the address or a choice names a section.
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const id = hashId();
      if (id !== null && sections.some((section) => section.id === id)) setActive(id);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
    };
  }, [sections]);

  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-10">
      <nav aria-label={t("sectionsLabel")} className="mb-6 lg:sticky lg:top-24 lg:mb-0">
        <div className="lg:hidden">
          <label htmlFor="settings-section" className="mb-1 block text-helper text-fg-muted">
            {t("jumpTo")}
          </label>
          <select
            id="settings-section"
            value={active ?? sections[0]?.id ?? ""}
            onChange={(event) => {
              window.location.hash = event.target.value;
            }}
            className="min-h-11 w-full rounded-control border border-line-control bg-surface px-3 text-body text-fg"
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </select>
        </div>
        <ul className="hidden flex-col gap-1 lg:flex">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={active === section.id ? "location" : undefined}
                className={cx(
                  "flex min-h-10 items-center rounded-control border border-transparent px-3 text-body text-fg-muted hover:bg-accent-subtle hover:text-fg",
                  "aria-[current=location]:bg-accent-subtle aria-[current=location]:font-semibold aria-[current=location]:text-fg",
                  "forced-colors:aria-[current=location]:border-[Highlight]",
                )}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex max-w-2xl min-w-0 flex-col gap-10">{children}</div>
    </div>
  );
}

export interface SettingsGroupProps {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * One group of cards. The label only helps sighted people scan (the section list names the same
 * groups for everyone else), so it is neither a heading nor a landmark: each card keeps its own.
 */
export function SettingsGroup({ id, label, children }: SettingsGroupProps) {
  return (
    <div id={id} className="scroll-mt-24">
      <p aria-hidden="true" className="mb-3 text-helper font-semibold tracking-wide text-fg-muted">
        {label}
      </p>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}
