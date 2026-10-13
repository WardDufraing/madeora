import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom has no <dialog> behaviour. This stub only opens and closes the element and fires the
// events the Dialog component listens to; focus trapping, inertness and Escape handling are
// browser features, tested in real Chromium by the Playwright suite.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    const first = this.querySelector<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]",
    );
    first?.focus();
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
