import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { axeViolations } from "@/test/axe";

import { TextField } from "./text-field";

describe("TextField", () => {
  it("has a visible label tied to the input", async () => {
    render(<TextField label="Display name" name="displayName" />);

    const input = screen.getByLabelText("Display name");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("name", "displayName");
    expect(input).not.toHaveAttribute("aria-invalid");
    await userEvent.type(input, "Ward");
    expect(input).toHaveValue("Ward");
  });

  it("links the description and the error to the input and marks it invalid", () => {
    render(
      <TextField
        label="Email"
        type="email"
        description="We never share it."
        error="Enter a valid email address."
      />,
    );

    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAccessibleDescription("We never share it. Enter a valid email address.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a valid email address.")).toBeVisible();
  });

  it("marks required fields natively, with the asterisk hidden from screen readers", () => {
    render(<TextField label="Name" required />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toBeRequired();
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
  });

  it("forwards its ref to the input, so form libraries can register it", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField label="Name" ref={ref} />);
    expect(ref.current).toBe(screen.getByRole("textbox", { name: "Name" }));
  });

  it("gives every field its own ids", () => {
    render(
      <>
        <TextField label="First" error="First error" />
        <TextField label="Second" error="Second error" />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "First" })).toHaveAccessibleDescription(
      "First error",
    );
    expect(screen.getByRole("textbox", { name: "Second" })).toHaveAccessibleDescription(
      "Second error",
    );
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <TextField label="Plain" />
        <TextField label="Described" description="Help" />
        <TextField label="Invalid" required error="Wrong" />
        <TextField label="Disabled" disabled />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
