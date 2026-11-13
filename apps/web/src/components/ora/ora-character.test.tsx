import { act, render, screen } from "@testing-library/react";

import { axeViolations } from "@/test/axe";

import { OraCharacter } from "./ora-character";

describe("OraCharacter", () => {
  it("is hidden from assistive technology unless it stands alone with a name", () => {
    const { container, rerender } = render(<OraCharacter />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<OraCharacter label="Ora" />);
    expect(screen.getByRole("img", { name: "Ora" })).toBeInTheDocument();
  });

  it("uses Heather by default and carries the chosen palette as variables, no fixed colour name", () => {
    const { container, rerender } = render(<OraCharacter label="Ora" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.palette).toBe("heather");
    expect(root.style.getPropertyValue("--ora-body-0")).toBe("#e9e0ee");
    rerender(<OraCharacter label="Ora" palette="denim" />);
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue("--ora-body-0"),
    ).toBe("#e0eaf3");
    // The reference's accessible name said "cream"; no colour word may leak into the markup.
    expect(container.innerHTML.toLowerCase()).not.toContain("cream");
  });

  it("gives every instance its own gradient and filter ids", () => {
    const { container } = render(
      <>
        <OraCharacter />
        <OraCharacter palette="olive" />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
    // Every url(#…) points at an id in the same document.
    for (const match of container.innerHTML.matchAll(/url\(#([^)]+)\)/g)) {
      expect(ids).toContain(match[1]);
    }
  });

  it("shows each expression's face by swapping paths, not by CSS path morphing", () => {
    const { container, rerender } = render(<OraCharacter expression="concerned" />);
    const smile = () => container.querySelector(".smile")?.getAttribute("d");
    const concerned = smile();
    rerender(<OraCharacter expression="happy" />);
    expect(smile()).not.toBe(concerned);
    rerender(<OraCharacter expression="surprised" />);
    expect(container.querySelector(".mouth-open")?.getAttribute("d")).toContain("C 191 184");
  });

  it("returns to calm after a brief reaction and holds sustained ones", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<OraCharacter expression="cheer" />);
      const state = () => (container.firstElementChild as HTMLElement).dataset.state;
      expect(state()).toBe("cheer");
      act(() => {
        vi.advanceTimersByTime(1800);
      });
      expect(state()).toBe("idle");

      rerender(<OraCharacter expression="thinking" />);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(state()).toBe("thinking");

      // The same expression plays again for a new replay key.
      rerender(<OraCharacter expression="wave" replayKey={1} />);
      expect(state()).toBe("wave");
      act(() => {
        vi.advanceTimersByTime(1900);
      });
      expect(state()).toBe("idle");
      rerender(<OraCharacter expression="wave" replayKey={2} />);
      expect(state()).toBe("wave");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the motion mode to the stylesheet", () => {
    const { container, rerender } = render(<OraCharacter />);
    const mode = () => (container.firstElementChild as HTMLElement).dataset.motion;
    expect(mode()).toBe("gentle");
    rerender(<OraCharacter motion="none" />);
    expect(mode()).toBe("none");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<OraCharacter label="Ora" expression="happy" />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
