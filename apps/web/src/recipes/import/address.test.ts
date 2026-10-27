import { isPublicAddress } from "./address";

describe("isPublicAddress", () => {
  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:82a::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("allows the public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    // IPv4: this network, private, CGNAT, loopback, link-local/metadata, documentation, multicast, broadcast.
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    // IPv6: unspecified, loopback, mapped/compatible/translated private, NAT64 private, 6to4, Teredo,
    // documentation, unique local, link-local (with and without zone), site-local, multicast, discard.
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "::ffff:0:10.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "2002:c0a8:101::1",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "100::1",
  ])("refuses the non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["localhost", "example.com", "", "1.2.3", "999.1.1.1", "0x7f.0.0.1", "2130706433"])(
    "refuses %j, which is not an IP address",
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );
});
