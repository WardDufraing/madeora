import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { axeViolations } from "@/test/axe";

import { TextArea } from "./text-area";

describe("TextArea", () => {
  it("has a visible label tied to a multi-line field", async () => {
    render(<TextArea label="Statement" name="statement" />);
    const field = screen.getByRole("textbox", { name: "Statement" });
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAttribute("rows", "5");
    expect(field).not.toHaveAttribute("aria-invalid");
    await userEvent.type(field, "Line one{enter}Line two");
    expect(field).toHaveValue("Line one\nLine two");
  });

  it("links the description and the error and marks it invalid", () => {
    render(<TextArea label="Reason" description="Only staff read this." error="Too short." />);
    const field = screen.getByRole("textbox", { name: "Reason" });
    expect(field).toHaveAccessibleDescription("Only staff read this. Too short.");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("marks required fields natively and forwards its ref", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea label="Reason" required ref={ref} />);
    const field = screen.getByRole("textbox", { name: "Reason" });
    expect(field).toBeRequired();
    expect(ref.current).toBe(field);
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <TextArea label="Plain" />
        <TextArea label="Invalid" required description="Help" error="Wrong" />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
