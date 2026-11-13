import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import en from "@/i18n/messages/en.json";
import { ORA_OPEN_EVENT, type OraOpenDetail } from "@/ora/open-event";

import { OraWidgetActions } from "./ora-widget-actions";

describe("Ora widget actions", () => {
  it("only asks the shared panel to open on the right period", async () => {
    const seen: OraOpenDetail[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<OraOpenDetail>).detail);
    };
    window.addEventListener(ORA_OPEN_EVENT, listener);
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <OraWidgetActions />
      </NextIntlClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Today's overview" }));
    await user.click(screen.getByRole("button", { name: "This week" }));
    window.removeEventListener(ORA_OPEN_EVENT, listener);
    expect(seen).toEqual([
      { view: "overview", target: "today" },
      { view: "overview", target: "this-week" },
    ]);
  });
});
