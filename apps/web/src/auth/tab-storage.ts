/**
 * Per-account drafts this tab keeps in sessionStorage (an unsaved recipe edit, cooking progress).
 * They belong to the person signed in when they were written, so they go when that person signs
 * out or another account appears in the tab (S24-L2: a shared device must not offer one person's
 * unsaved changes to the next).
 */
const ACCOUNT_PREFIXES = ["madeora:recipe-"] as const;

export function clearAccountTabStorage(): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && ACCOUNT_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // No storage in this tab (private mode, blocked): nothing was kept.
  }
}
