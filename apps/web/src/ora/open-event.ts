import type { OverviewTarget } from "./overview/types";

/**
 * How a page asks the always-present Ora bubble or sheet to open on its overview (S46: the
 * dashboard widget). The widget owns no panel of its own: the one shared surface opens, in the
 * context of the page the person is on.
 */
export const ORA_OPEN_EVENT = "madeora:open-ora";

export interface OraOpenDetail {
  readonly view: "overview";
  readonly target: OverviewTarget;
}

export function requestOraOpen(detail: OraOpenDetail): void {
  window.dispatchEvent(new CustomEvent<OraOpenDetail>(ORA_OPEN_EVENT, { detail }));
}
