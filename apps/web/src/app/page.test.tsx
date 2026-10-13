import { render, screen } from "@testing-library/react";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders a single top-level heading inside the main landmark", () => {
    render(<HomePage />);

    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Madeora");
    expect(main).toContainElement(heading);
  });
});
