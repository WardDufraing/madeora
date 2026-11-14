import { screen } from "@testing-library/react";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { DisplayOra } from "./display-widgets";

describe("Display-only Ora", () => {
  it("says one calm line from the counts the display already shows, with nothing to press or type", async () => {
    const { container } = renderWithIntl(<DisplayOra chores={3} shoppingRemaining={1} />);
    const widget = screen.getByTestId("display-ora");
    expect(widget).toHaveTextContent("3 chores are open. 1 shopping item is still needed.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("img", { name: "Ora" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps quiet company instead of inventing something when there is nothing to say", () => {
    renderWithIntl(<DisplayOra chores={0} shoppingRemaining={0} />);
    expect(screen.getByTestId("display-ora")).toHaveTextContent("All quiet for now.");
  });

  it("speaks Dutch with the display's language", () => {
    renderWithIntl(<DisplayOra chores={1} shoppingRemaining={0} />, "nl");
    expect(screen.getByTestId("display-ora")).toHaveTextContent("1 taak staat open.");
  });
});
