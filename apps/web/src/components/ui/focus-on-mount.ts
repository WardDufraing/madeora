/**
 * A ref callback that moves focus to the element when it appears, for a field the person just asked
 * for (Rename, Edit). Used instead of `autoFocus`, which also fires on page load; this only runs
 * when the person opened the field.
 */
export function focusOnMount(element: HTMLElement | null): void {
  element?.focus();
}
