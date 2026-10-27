import { isIP } from "node:net";

/**
 * Which network addresses a recipe import may connect to (S25, ARCH §38: SSRF protection). Only
 * public unicast addresses: anything that could reach this server, its private network, a cloud
 * metadata service or a special-purpose range is refused. Pure, so every range is unit-tested.
 */

/** An IPv4 address as a 32-bit number, or null when `text` is not a dotted quad. */
function ipv4Number(text: string): number | null {
  if (isIP(text) !== 4) return null;
  return text.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

// [first address, prefix length] of every IPv4 range an import may not reach (IANA special-purpose
// registry, plus the ranges that are not globally reachable).
const blockedIpv4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function inIpv4Range(address: number, [first, prefix]: readonly [string, number]): boolean {
  const start = ipv4Number(first) ?? 0;
  const size = 2 ** (32 - prefix);
  return address >= start && address < start + size;
}

function ipv4Blocked(address: number): boolean {
  return blockedIpv4.some((range) => inIpv4Range(address, range));
}

/** The eight 16-bit groups of an IPv6 address (with an embedded IPv4 tail expanded), or null. */
function ipv6Groups(text: string): number[] | null {
  if (isIP(text) !== 6) return null;
  let address = text.toLowerCase();
  // A zone index (fe80::1%eth0) names a local interface: never public.
  if (address.includes("%")) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (tail?.[1]) {
    const v4 = ipv4Number(tail[1]);
    if (v4 === null) return null;
    address = `${address.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = "", rest] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function ipv6Blocked(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = ((g6 << 16) + g7) >>> 0;
  // :: (unspecified) and ::1 (loopback); ::a.b.c.d (IPv4-compatible, deprecated).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated): judged as the IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return ipv4Blocked(embedded);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b::/96 (NAT64 well-known): judged as the IPv4 address. 64:ff9b:1::/48 (local NAT64).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4Blocked(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID…), 2001:db8::/32
  // documentation, 2002::/16 6to4 (can embed any IPv4 address), 3fff::/20 documentation.
  if (g0 === 0x2001 && g1 < 0x200) return true;
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  if (g0 === 0x2002) return true;
  if (g0 === 0x3fff && g1 < 0x1000) return true;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  // Only global unicast (2000::/3) is public.
  return (g0 & 0xe000) !== 0x2000;
}

/** Whether an import may connect to this IP address. Anything that is not an IP address is refused. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) return !ipv4Blocked(v4);
  const v6 = ipv6Groups(address);
  if (v6 !== null) return !ipv6Blocked(v6);
  return false;
}
