import { render } from "@testing-library/react";

import { DeviceTimeZone, detectDeviceTimeZone } from "./device-time-zone";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function reportZone(zone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat("en", { timeZone: "UTC" }).resolvedOptions(),
    timeZone: zone,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  router.refresh.mockClear();
  document.cookie = "md-timezone=; Max-Age=0; Path=/";
});

describe("DeviceTimeZone", () => {
  it("saves a newly detected zone on this device and refreshes the page, once", () => {
    reportZone("Europe/Brussels");
    render(<DeviceTimeZone saved={undefined} />);
    expect(document.cookie).toContain("md-timezone=Europe%2FBrussels");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the zone is the one already saved", () => {
    reportZone("Europe/Brussels");
    render(<DeviceTimeZone saved="Europe/Brussels" />);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("follows the device when it travels, checked when the page is shown again", () => {
    reportZone("Europe/Brussels");
    render(<DeviceTimeZone saved="Europe/Brussels" />);
    reportZone("America/New_York");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.cookie).toContain("md-timezone=America%2FNew_York");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the cookie could not be stored (cookies blocked)", () => {
    reportZone("Europe/Brussels");
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => undefined,
    });
    try {
      render(<DeviceTimeZone saved={undefined} />);
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      delete (document as { cookie?: string }).cookie;
      if (descriptor) Object.defineProperty(Document.prototype, "cookie", descriptor);
    }
  });

  it("ignores a zone the browser reports that is not an IANA name", () => {
    reportZone("+05:00");
    expect(detectDeviceTimeZone()).toBeNull();
    render(<DeviceTimeZone saved={undefined} />);
    expect(document.cookie).not.toContain("md-timezone");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
