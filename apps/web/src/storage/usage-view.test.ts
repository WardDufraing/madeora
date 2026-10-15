import {
  availableBytes,
  countedBytes,
  formatBytes,
  percentUsed,
  toStorageUsage,
  warningLevel,
  type StorageUsage,
} from "./usage-view";

const GiB = 1024 ** 3;
function usage(parts: Partial<StorageUsage>): StorageUsage {
  return { allowance: GiB, used: 0, deleted: 0, reserved: 0, warning: 0, ...parts };
}

describe("storage usage", () => {
  it("reads a database row, keeping only the known warning levels and no negative numbers", () => {
    expect(
      toStorageUsage({
        allowance_bytes: 1000,
        used_bytes: -5,
        deleted_bytes: 10,
        reserved_bytes: 20,
        warning_level: 42,
      }),
    ).toEqual({ allowance: 1000, used: 0, deleted: 10, reserved: 20, warning: 0 });
    expect(
      toStorageUsage({
        allowance_bytes: 1,
        used_bytes: 0,
        deleted_bytes: 0,
        reserved_bytes: 0,
        warning_level: 95,
      }).warning,
    ).toBe(95);
  });

  it("counts recoverable deleted files against the allowance and keeps reservations out of the percentage", () => {
    const pool = usage({ allowance: 1000, used: 500, deleted: 200, reserved: 100 });
    expect(countedBytes(pool)).toBe(700);
    expect(percentUsed(pool)).toBe(70);
    expect(availableBytes(pool)).toBe(200);
  });

  it("never shows negative space when a lowered allowance leaves a pool over it", () => {
    const pool = usage({ allowance: 100, used: 300 });
    expect(availableBytes(pool)).toBe(0);
    expect(percentUsed(pool)).toBe(100);
    expect(warningLevel(pool)).toBe("full");
  });

  it.each([
    [0, "none"],
    [79, "none"],
    [80, "warning"],
    [94, "warning"],
    [95, "critical"],
    [99, "critical"],
    [100, "full"],
  ] as const)("at %i%% shows %s", (percent, level) => {
    expect(warningLevel(usage({ allowance: 100, used: percent }))).toBe(level);
  });

  it("treats a zero allowance as full only once something is stored", () => {
    expect(percentUsed(usage({ allowance: 0 }))).toBe(0);
    expect(warningLevel(usage({ allowance: 0, used: 1 }))).toBe("full");
  });
});

describe("formatBytes", () => {
  it("writes sizes in binary steps in the reader's language", () => {
    expect(formatBytes(0, "en")).toBe("0 byte");
    expect(formatBytes(512 * 1024, "en")).toBe("512 kB");
    expect(formatBytes(1.5 * 1024 ** 2, "en")).toBe("1.5 MB");
    expect(formatBytes(1.5 * 1024 ** 2, "nl")).toBe("1,5 MB");
    expect(formatBytes(GiB, "en")).toBe("1 GB");
    expect(formatBytes(-10, "en")).toBe("0 byte");
  });
});
