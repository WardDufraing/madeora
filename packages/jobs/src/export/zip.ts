/**
 * A small ZIP writer for data export archives (S39): no dependency, `node:zlib` only. Text entries
 * are deflated; media (already compressed) are stored. Names are UTF-8 (general purpose bit 11),
 * times are the archive's generation time in UTC. No ZIP64: the export job keeps an archive far
 * below 4 GiB and 65,535 entries, and refuses anything larger before writing.
 */
import { crc32, deflateRawSync } from "node:zlib";

export const MAX_ZIP_ENTRIES = 60_000;
export const MAX_ZIP_BYTES = 0xffff_fffe;

export interface ZipEntry {
  /** Forward slashes, no leading slash, no `..` segments. */
  readonly name: string;
  readonly data: Uint8Array;
  /** True to deflate (text); false to store (already compressed media). */
  readonly compress: boolean;
}

const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]{1,240}$/;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Builds the whole archive in memory. Throws on unsafe names, duplicates or size limits. */
export function buildZip(entries: readonly ZipEntry[], modified: Date): Uint8Array {
  if (entries.length > MAX_ZIP_ENTRIES) throw new RangeError("too many entries");
  const { time, date } = dosDateTime(modified);
  const names = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!SAFE_NAME.test(entry.name) || names.has(entry.name)) {
      throw new TypeError("unsafe or duplicate entry name");
    }
    names.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const body = entry.compress ? deflateRawSync(raw) : raw;
    const method = entry.compress ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > MAX_ZIP_BYTES) throw new RangeError("archive too large");
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize + 22 > MAX_ZIP_BYTES) throw new RangeError("archive too large");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  // A Buffer is a Uint8Array: returned as is, since copying it would double the peak memory.
  return Buffer.concat([...locals, ...centrals, end]);
}
