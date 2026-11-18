// S42P-L3: the claim pages carry the transition token in their address, so they must never send
// it on to another site in a Referer header.
import { generateMetadata as claimMetadata } from "./page";
import { generateMetadata as verifyMetadata } from "./verify/page";

vi.mock("next-intl/server", () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock("@/i18n/page-title", () => ({ pageTitle: (title: string) => Promise.resolve(title) }));
vi.mock("@/child-transition/service", () => ({}));

describe("claim page metadata", () => {
  it.each([
    ["claim", claimMetadata],
    ["verify", verifyMetadata],
  ])("sets no-referrer on the %s page", async (_page, generate) => {
    expect(await generate()).toMatchObject({ referrer: "no-referrer" });
  });
});
