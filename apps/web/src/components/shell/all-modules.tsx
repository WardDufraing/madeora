"use client";

import { PinIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";

import { useFavorites } from "./favorites";
import { contextHref, coreNav, moduleNav, type NavItem } from "./nav-items";

export interface AllModulesProps {
  /** The open Home, or `null` in Personal: every link opens that context. */
  readonly homeId: string | null;
}

/**
 * The searchable catalogue of every module (redesign decision 10). Core destinations are always
 * in the menu; every other module can be pinned as a shortcut or unpinned. Pinning only changes
 * which links are shown: each destination still checks the person's access itself.
 */
export function AllModules({ homeId }: AllModulesProps) {
  const t = useTranslations("Modules");
  const tNav = useTranslations("Nav");
  const { announce, region } = useAnnouncer();
  const favorites = useFavorites();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();

  const matches = (item: NavItem) => tNav(item.id).toLocaleLowerCase().includes(needle);
  const core = coreNav.filter(matches);
  const modules = moduleNav.filter(matches);

  function togglePin(item: NavItem) {
    const name = tNav(item.id);
    const wasPinned = favorites.isPinned(item.id);
    favorites.toggle(item.id);
    announce(wasPinned ? t("unpin", { module: name }) : t("pin", { module: name }));
  }

  return (
    <div className="flex flex-col gap-6">
      <TextField
        label={t("searchLabel")}
        type="search"
        value={query}
        placeholder={t("searchPlaceholder")}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="max-w-md"
      />
      {region}
      <p role="status" className="sr-only">
        {t("resultCount", { count: core.length + modules.length })}
      </p>
      {core.length + modules.length === 0 ? (
        <EmptyState title={t("noResults", { query: query.trim() })} />
      ) : null}
      {core.length > 0 ? (
        <section aria-labelledby="modules-core" className="flex flex-col gap-3">
          <h2 id="modules-core" className="text-section-title font-semibold">
            {t("core")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {core.map((item) => (
              <li key={item.id}>
                <ModuleLink item={item} href={contextHref(item, homeId)} label={tNav(item.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {modules.length > 0 ? (
        <section aria-labelledby="modules-others" className="flex flex-col gap-3">
          <h2 id="modules-others" className="text-section-title font-semibold">
            {t("others")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((item) => {
              const pinned = favorites.isPinned(item.id);
              const name = tNav(item.id);
              return (
                <li key={item.id} className="flex items-stretch gap-2">
                  <ModuleLink item={item} href={contextHref(item, homeId)} label={name} />
                  <button
                    type="button"
                    aria-pressed={pinned}
                    aria-label={t("pinToggle", { module: name })}
                    onClick={() => {
                      togglePin(item);
                    }}
                    className={cx(
                      "inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control border",
                      pinned
                        ? "border-accent bg-accent-subtle text-fg shadow-inset"
                        : "border-line-control bg-surface text-fg-muted shadow-raised hover:bg-accent-subtle",
                    )}
                  >
                    <PinIcon size="md" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ModuleLink({
  item,
  href,
  label,
}: {
  readonly item: NavItem;
  readonly href: string;
  readonly label: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={href}
      className="flex min-h-12 flex-1 items-center gap-3 rounded-card border border-line bg-surface px-4 text-body font-medium text-fg shadow-raised hover:bg-accent-subtle"
    >
      <Icon size="md" className="text-fg-muted" />
      {label}
    </Link>
  );
}
