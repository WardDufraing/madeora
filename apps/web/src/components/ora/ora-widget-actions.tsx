"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { requestOraOpen } from "@/ora/open-event";
import type { OverviewTarget } from "@/ora/overview/types";

/**
 * The dashboard widget's buttons (S46). They only ask the one shared Ora bubble or sheet to open on
 * the overview; the widget has no panel, preview or state of its own. The panel works in the place
 * of the page the person is on, which is the widget's own place (the widget is offered only on a
 * Home's dashboard and on the personal one).
 */
export function OraWidgetActions() {
  const t = useTranslations("OraWidget");
  const open = (target: OverviewTarget) => () => {
    requestOraOpen({ view: "overview", target });
  };
  return (
    <ul className="flex flex-wrap gap-2">
      <li>
        <Button size="sm" onClick={open("today")}>
          {t("today")}
        </Button>
      </li>
      <li>
        <Button size="sm" variant="secondary" onClick={open("this-week")}>
          {t("week")}
        </Button>
      </li>
    </ul>
  );
}
