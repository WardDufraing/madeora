import type messages from "./messages/en.json";
import type { Locale } from "./locales";

// Typed keys: using a message key that is not in the English dictionary fails type checking.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
