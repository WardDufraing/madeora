"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { saveDeviceTimeZone } from "@/preferences/client";
import { normalizeTimeZone, TIMEZONE_COOKIE } from "@/preferences/timezone";

export interface DeviceTimeZoneProps {
  /** The zone this device reported last time (from its cookie), as the server read it. */
  readonly saved: string | undefined;
}

/** The zone the browser reports for this device, or `null` when it reports none or an odd one. */
export function detectDeviceTimeZone(): string | null {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * Keeps this device's timezone cookie up to date (spec: automatic mode follows the device, also
 * when it travels). When the zone differs from the saved one, it saves the new zone and refreshes
 * the server-rendered page, so times follow. Checked on load and whenever the page regains focus.
 * It only changes how times are shown; nothing stored is rewritten. Renders nothing.
 */
export function DeviceTimeZone({ saved }: DeviceTimeZoneProps) {
  const router = useRouter();

  useEffect(() => {
    let current = saved;
    const check = () => {
      const detected = detectDeviceTimeZone();
      if (detected === null || detected === current) return;
      current = detected;
      saveDeviceTimeZone(detected);
      // Only when the cookie was really stored (cookies may be blocked): otherwise every page
      // load would refresh again for nothing, and the server keeps its fallback.
      if (document.cookie.includes(`${TIMEZONE_COOKIE}=${encodeURIComponent(detected)}`)) {
        router.refresh();
      }
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [saved, router]);

  return null;
}
