import { useTranslations } from "next-intl";

import type { TransitionSummary } from "@/child-transition/service";

/** What the move keeps and ends, for the young person's review screens (S42 part 3). */
export function TransitionSummaryList({ summary }: { readonly summary: TransitionSummary }) {
  const t = useTranslations("ChildTransition");
  return (
    <div className="flex flex-col gap-4" data-testid="transition-summary">
      <section aria-labelledby="transition-keeps" className="flex flex-col gap-2">
        <h2 id="transition-keeps" className="text-body font-semibold text-fg">
          {t("keepsTitle")}
        </h2>
        <ul className="list-disc ps-6 text-body text-fg">
          {summary.name ? (
            <li>
              {t("keepsName")} <bdi className="font-medium">{summary.name}</bdi>
            </li>
          ) : null}
          <li>
            {t("keepsHomes", { count: summary.homes.length })}{" "}
            {summary.homes.map((home, index) => (
              <span key={`${home}-${String(index)}`}>
                {index > 0 ? ", " : ""}
                <bdi className="font-medium">{home}</bdi>
              </span>
            ))}
          </li>
          <li>{t("keepsHistory")}</li>
        </ul>
      </section>
      <section aria-labelledby="transition-ends" className="flex flex-col gap-2">
        <h2 id="transition-ends" className="text-body font-semibold text-fg">
          {t("endsTitle")}
        </h2>
        <ul className="list-disc ps-6 text-body text-fg">
          <li>{t("endsGuardians", { count: summary.guardians })}</li>
          {summary.hasUsername ? <li>{t("endsUsername")}</li> : null}
          {summary.pinHomes > 0 ? <li>{t("endsPins", { count: summary.pinHomes })}</li> : null}
        </ul>
      </section>
    </div>
  );
}
