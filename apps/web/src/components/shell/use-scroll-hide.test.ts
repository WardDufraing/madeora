import { nextScrollState } from "./use-scroll-hide";

type State = { hidden: boolean; anchor: number };
const run = (start: State, positions: readonly number[]): State =>
  positions.reduce<State>((state, y) => nextScrollState(state, y), start);

describe("nextScrollState", () => {
  it("is always shown near the top of the page", () => {
    expect(run({ hidden: true, anchor: 400 }, [20])).toEqual({ hidden: false, anchor: 20 });
    expect(nextScrollState({ hidden: false, anchor: 0 }, -40)).toEqual({
      hidden: false,
      anchor: 0,
    });
  });

  it("ignores small downward movements", () => {
    expect(run({ hidden: false, anchor: 200 }, [210, 220, 225]).hidden).toBe(false);
  });

  it("hides after a deliberate run down, past the first screen", () => {
    expect(run({ hidden: false, anchor: 100 }, [120, 150, 180]).hidden).toBe(true);
    // Not past the first screen yet: stays shown.
    expect(run({ hidden: false, anchor: 30 }, [60, 90]).hidden).toBe(false);
  });

  it("shows again after a short run up, but not after a tiny flick", () => {
    const hidden: State = { hidden: true, anchor: 500 };
    expect(run(hidden, [495, 490]).hidden).toBe(true);
    expect(run(hidden, [480, 470]).hidden).toBe(false);
  });

  it("measures the upward run from the lowest point reached while hidden", () => {
    expect(run({ hidden: true, anchor: 300 }, [340, 380, 370]).hidden).toBe(true);
    expect(run({ hidden: true, anchor: 300 }, [340, 380, 360]).hidden).toBe(false);
  });

  it("does not flicker when direction flips", () => {
    let state: State = { hidden: false, anchor: 200 };
    for (const y of [215, 205, 220, 210, 225, 215]) state = nextScrollState(state, y);
    expect(state.hidden).toBe(false);
  });
});
