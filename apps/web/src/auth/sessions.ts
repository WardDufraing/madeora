/**
 * Devices and sessions (S37, spec "Confirmed adult device and session management"): a best-effort,
 * privacy-conscious description of each session from the browser's user agent. It is a hint for
 * the account holder, never proof of identity, and no IP address or location is shown.
 */
const DEVICE_KINDS = ["phone", "tablet", "computer", "unknown"] as const;
const BROWSERS = ["edge", "chrome", "firefox", "safari", "samsung", "opera", "other"] as const;
const PLATFORMS = [
  "windows",
  "macos",
  "ios",
  "ipados",
  "android",
  "linux",
  "chromeos",
  "other",
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Browser = (typeof BROWSERS)[number];
export type Platform = (typeof PLATFORMS)[number];

export interface DeviceDescription {
  readonly kind: DeviceKind;
  readonly browser: Browser;
  readonly platform: Platform;
}

function browserOf(ua: string): Browser {
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "opera";
  if (/\bSamsungBrowser\//.test(ua)) return "samsung";
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return "firefox";
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(ua)) return "chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "safari";
  return "other";
}

function platformOf(ua: string): Platform {
  if (/\biPad\b/.test(ua)) return "ipados";
  if (/\b(?:iPhone|iPod)\b/.test(ua)) return "ios";
  if (/\bAndroid\b/.test(ua)) return "android";
  if (/\bCrOS\b/.test(ua)) return "chromeos";
  if (/\bWindows\b/.test(ua)) return "windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macos";
  if (/\bLinux\b/.test(ua)) return "linux";
  return "other";
}

function kindOf(ua: string, platform: Platform): DeviceKind {
  if (platform === "ipados" || /\bTablet\b/.test(ua)) return "tablet";
  if (platform === "android") return /\bMobile\b/.test(ua) ? "phone" : "tablet";
  if (platform === "ios" || /\bMobile\b/.test(ua)) return "phone";
  if (platform === "other") return "unknown";
  return "computer";
}

export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? "").slice(0, 512);
  if (ua === "") return { kind: "unknown", browser: "other", platform: "other" };
  const platform = platformOf(ua);
  return { kind: kindOf(ua, platform), browser: browserOf(ua), platform };
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A description stored earlier (a trusted browser); anything unexpected reads as "other". */
export function storedDevice(kind: string, browser: string, platform: string): DeviceDescription {
  return {
    kind: oneOf(DEVICE_KINDS, kind, "unknown"),
    browser: oneOf(BROWSERS, browser, "other"),
    platform: oneOf(PLATFORMS, platform, "other"),
  };
}

/** One row of Settings › Security › Devices and sessions. */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly device: DeviceDescription;
  readonly isCurrent: boolean;
}

/**
 * An email address with most of its first part hidden ("a•••@example.com"), for showing a pending
 * change without spelling out both addresses in full on a screen others may see.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = address.slice(0, at);
  const first = Array.from(local)[0] ?? "";
  return `${first}•••${address.slice(at)}`;
}
