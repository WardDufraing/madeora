import { dummyChildSecretHash, hashChildSecret, verifyChildSecret } from "./secret-hash";

// The database's own check (private.is_child_secret_hash): the server's format must pass it.
const DATABASE_FORMAT = /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

describe("child secret hashes (S42)", () => {
  it("makes a salted scrypt hash in the format the database accepts", async () => {
    const first = await hashChildSecret("2580");
    const second = await hashChildSecret("2580");
    expect(first).toMatch(DATABASE_FORMAT);
    expect(second).toMatch(DATABASE_FORMAT);
    expect(first).not.toBe(second);
    expect(first).not.toContain("2580");
  });

  it("accepts the right secret and refuses a wrong one", async () => {
    const stored = await hashChildSecret("correct horse");
    await expect(verifyChildSecret("correct horse", stored)).resolves.toBe(true);
    await expect(verifyChildSecret("correct hors", stored)).resolves.toBe(false);
  });

  it("never matches a malformed hash or the dummy hash", async () => {
    await expect(verifyChildSecret("2580", "2580")).resolves.toBe(false);
    await expect(verifyChildSecret("2580", "scrypt$15$8$1$short$short")).resolves.toBe(false);
    await expect(verifyChildSecret("", await dummyChildSecretHash())).resolves.toBe(false);
  });
});
