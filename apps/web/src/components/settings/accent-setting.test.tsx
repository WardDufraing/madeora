import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AccentStyle } from "@/components/accent/accent-style";
import { MemberAvatar } from "@/components/members/member-avatar";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { AccentSetting } from "./accent-setting";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;

function respondWith(accentColor: string | null) {
  fetchMock.mockResolvedValue(Response.json({ preferences: { accentColor } }, { status: 200 }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("AccentSetting", () => {
  it("starts on the default colour and saves a palette colour to the account", async () => {
    respondWith("#0d9488");
    const user = userEvent.setup();
    const { container } = renderWithQuery(<AccentSetting initialColor={null} />);
    expect(screen.getByRole("radio", { name: "Purple" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Use the default colour" })).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Accent colour saved.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/me/preferences");
    expect(bodyOf(init)).toEqual({ accentColor: "#0d9488" });
    expect(router.refresh).toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("returns to the default colour", async () => {
    respondWith(null);
    const user = userEvent.setup();
    renderWithQuery(<AccentSetting initialColor="#123abc" />);
    expect(screen.getByRole("radio", { name: "Your own colour" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Hex code" })).toHaveValue("#123abc");
    await user.click(screen.getByRole("button", { name: "Use the default colour" }));
    expect(await screen.findByText("The default colour is back.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: null });
  });

  it("treats the palette's purple as the default colour", async () => {
    respondWith(null);
    const user = userEvent.setup();
    renderWithQuery(<AccentSetting initialColor="#0d9488" />);
    await user.click(screen.getByRole("radio", { name: "Purple" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: null });
    });
  });

  it("flags an invalid hex code and keeps the last valid colour", async () => {
    respondWith("#123abc");
    const user = userEvent.setup();
    renderWithQuery(<AccentSetting initialColor="#123abc" />);
    const hex = screen.getByRole("textbox", { name: "Hex code" });
    await user.clear(hex);
    await user.type(hex, "blue");
    await user.tab();
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Enter a colour as #/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: "#123abc" });
    });
  });

  it("says when a colour was adjusted for readable text", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AccentSetting initialColor={null} />);
    const hex = screen.getByRole("textbox", { name: "Hex code" });
    await user.clear(hex);
    await user.type(hex, "#777777");
    expect(screen.getByText("Adjusted slightly so text on it stays readable.")).toBeInTheDocument();
  });
});

describe("MemberAvatar", () => {
  it("shows initials on the readable fill, hidden from screen readers", () => {
    render(<MemberAvatar name="Alice van Dam" accentColor="#2563eb" locale="en" />);
    const avatar = screen.getByTestId("member-avatar");
    expect(avatar).toHaveTextContent("AD");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveStyle({ backgroundColor: "#2563eb", color: "#ffffff" });
  });

  it("shows a neutral mark without a name", () => {
    render(<MemberAvatar name={null} accentColor={null} locale="en" />);
    expect(screen.getByTestId("member-avatar")).toHaveTextContent("\u{2022}");
  });
});

describe("AccentStyle", () => {
  it("renders the accent variables for a colour and nothing for the default", () => {
    const { container, rerender } = render(<AccentStyle color="#2563eb" />);
    const style = container.querySelector("style");
    expect(style?.textContent).toContain("--md-color-accent: #2563eb;");
    expect(style?.textContent).toContain('[data-theme="dark"]');
    rerender(<AccentStyle color={null} />);
    expect(container.querySelector("style")).toBeNull();
  });
});
