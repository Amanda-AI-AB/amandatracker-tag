// The withdrawal signal (AAI-785): on a site whose config turns purge on withdrawal on
// (consent.purge_on_withdrawal, AAI-226), a visitor who withdraws their consent has the tag post
// POST <endpoint>/v1/w (schema/v1/withdrawal.json) with their visitor id, just before identity's
// forget() deletes their cookies (identity.ts, beforeForget). The processor then erases what is
// stored about that visitor through the DSAR cascade delete. The signal carries the visitor id and
// nothing about the page, and goes without cookies and with keepalive (withdrawalRequestInit).
//
// It is sent once, as the cookies go: no timed retry follows, since the cookies, and with them the
// visitor id, are gone by then. A 5xx or a network error is logged with console.warn; a refusal is
// a tag error, reported through the boundary. The cookies are deleted in every case.

import { buildWithdrawal } from "../wire/payload";
import { warn, type ErrorBoundary } from "./boundary";
import { withdrawalRequestInit, withdrawalUrl } from "./endpoint";
import { CollectorRefusedError } from "./transport";

export interface WithdrawalTarget {
  readonly endpoint: string;
  readonly site: string;
  readonly tagVersion: string;
}

/**
 * The sender of target's withdrawal signals: called with the visitor id, it posts one signal with
 * fetchFn. Building the signal throws WirePayloadError for an id the schema refuses; the post's
 * outcome is watched by the boundary, never thrown.
 */
export function withdrawalSender(
  fetchFn: typeof fetch,
  target: WithdrawalTarget,
  boundary: ErrorBoundary,
  now: () => number = Date.now,
): (visitorId: string) => void {
  return (visitorId) => {
    const body = JSON.stringify(
      buildWithdrawal({ tag_version: target.tagVersion, site_id: target.site, visitor_id: visitorId, client_ts: now() }),
    );
    const url = withdrawalUrl(target.endpoint);
    const sent = fetchFn(url, withdrawalRequestInit(body)).then(
      (response) => {
        if (response.ok) return;
        if (response.status >= 500) {
          warn(`amanda: the withdrawal signal to ${url} was not taken: HTTP ${response.status}`);
          return;
        }
        throw new CollectorRefusedError(`POST ${url}: HTTP ${response.status}, the withdrawal signal was refused`);
      },
      (error: unknown) => {
        // fetch rejects with a TypeError on a network error; anything else isn't one, and is reported.
        if (!(error instanceof TypeError)) throw error;
        warn(`amanda: the withdrawal signal to ${url} failed`, error);
      },
    );
    boundary.watch("transport", sent);
  };
}
