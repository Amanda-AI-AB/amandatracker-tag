// The pageview feed (AAI-964): where a.js sends each pageview the boot hands over, and each
// page_exit (engagement.ts, AAI-968). For the booted site's config it makes one consent state
// machine (consent.ts, with the config's declined mode), the visitor's identity (identity.ts) and
// one transport to the booted tag's endpoint (transport.ts), and feeds each item through the machine:
//
//   identified -> an event: the visitor and session ids, the consent snapshot, and its click IDs
//                 dropped under denied ads (attribution.ts, gateClickIds), sent with transport.event,
//                 which sends a page_exit at once by beacon;
//   declined   -> in declined mode `pings`, a pageview's anonymous ping (ping.ts, pingOf), with the
//                 page's click IDs only when the config's consent.pings_include_click_ids is on,
//                 sent with transport.ping; in mode `off`, nothing. A page_exit never becomes a ping,
//                 whose frozen field list has no engagement time: it is dropped in either mode;
//   pending    -> held by the machine until consent is decided, or the page goes: on pagehide a
//                 pending page_exit goes as a declined one does, which is nowhere.
//
// The machine's withdraw is the transport's withdrawEvents, so that nothing goes after a decline
// (AAI-86), and its pagehide is registered before the transport's, so that the pings it hands over
// as the page goes leave with the transport's own pagehide flush (consent.ts).

import { buildEvent, pingId } from "../wire/payload";
import { gateClickIds } from "./attribution";
import type { ErrorBoundary } from "./boundary";
import { declinedMode, pingsIncludeClickIds, type SiteConfig } from "./config";
import { createConsent, type ConsentMachine } from "./consent";
import type { PageExitInput } from "./engagement";
import { createIdentity, type IdentityHost } from "./identity";
import type { PageviewInput } from "./pageview";
import { pingOf } from "./ping";
import type { TagTarget } from "./telemetry";
import { createTransport, type TransportWindow } from "./transport";

/** The browser globals the feed uses: window, or a stand-in for it in tests. */
export interface FeedWindow extends TransportWindow, IdentityHost {}

/** What goes through the feed's machine. */
export type FeedItem = PageviewInput | PageExitInput;

export interface Feed {
  /**
   * The consent machine for the booted site's config, made with the transport and the identity it
   * feeds: boot's `consent` option. Called once, as the booted tag starts.
   */
  consent(config: SiteConfig): ConsentMachine<FeedItem>;
  /** Feeds a pageview through the machine: boot's `onPageview` option. */
  pageview(input: PageviewInput): void;
  /** Feeds a page_exit through the machine, as an event only: boot's `onPageExit` option. */
  pageExit(input: PageExitInput): void;
}

/**
 * The feed of the tag on win. target is the boot's (TagTarget): the transport goes to the endpoint
 * the boot resolved, read when the booted tag starts.
 */
export function createFeed(win: FeedWindow, boundary: ErrorBoundary, target: TagTarget): Feed {
  let machine: ConsentMachine<FeedItem> | undefined;
  const collect = (item: FeedItem): void => {
    // The boot makes the machine (consent) before it hands over its first item.
    if (!machine) throw new Error(`amanda: a ${item.type} came before the consent machine was made`);
    machine.collect(item);
  };
  return {
    consent(config) {
      if (machine) throw new Error("amanda: the pageview feed's consent machine was made already");
      const identity = createIdentity(win);
      // Before createTransport, which registers the transport's own pagehide flush.
      win.addEventListener("pagehide", () => boundary.guard("consent", () => machine!.pagehide()));
      const transport = createTransport(win, target.endpoint, boundary);
      const pingOptions = { clickIds: pingsIncludeClickIds(config) };
      machine = createConsent<FeedItem>({
        declinedMode: declinedMode(config),
        sink: {
          identified: (input, consent) => {
            const { visitorId, sessionId } = identity.ids();
            transport.event(buildEvent({ ...gateClickIds(input, consent), visitor_id: visitorId, session_id: sessionId, consent }));
          },
          anonymous: (input) => {
            // A page_exit is an event only: the ping's frozen field list has no engagement time.
            if (input.type === "page_exit") return;
            transport.ping(pingOf(input, pingId(), pingOptions));
          },
          withdraw: () => transport.withdrawEvents(),
        },
        identity,
      });
      return machine;
    },
    pageview: collect,
    pageExit: collect,
  };
}
