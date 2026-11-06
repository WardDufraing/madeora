import { describeDevice, maskEmail } from "./sessions";

describe("describeDevice", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      { kind: "phone", browser: "safari", platform: "ios" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      { kind: "computer", browser: "edge", platform: "windows" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
      { kind: "computer", browser: "firefox", platform: "macos" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      { kind: "phone", browser: "chrome", platform: "android" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Safari/537.36",
      { kind: "tablet", browser: "samsung", platform: "android" },
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
      { kind: "tablet", browser: "chrome", platform: "ipados" },
    ],
  ])("describes %s", (ua, expected) => {
    expect(describeDevice(ua)).toEqual(expected);
  });

  it("is honest about what it cannot tell", () => {
    expect(describeDevice(null)).toEqual({ kind: "unknown", browser: "other", platform: "other" });
    expect(describeDevice("curl/8.5.0")).toEqual({
      kind: "unknown",
      browser: "other",
      platform: "other",
    });
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("ada.lovelace@example.test")).toBe("a•••@example.test");
    expect(maskEmail("😀x@example.test")).toBe("😀•••@example.test");
    expect(maskEmail("broken")).toBe("•••");
  });
});
