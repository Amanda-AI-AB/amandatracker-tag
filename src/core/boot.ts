// The tag's boot: read the installing script tag, fetch the site's config, then install the
// command queue, send the first pageview and follow the single-page app's route changes. The
// engagement clock runs from the page's load, and each hide sends a page_exit (engagement.ts). A
// config that pins the site to another build hands off to it instead (canary.ts). Every step runs
// inside the error boundary: a failure is reported, and the page never sees it.

import { ADAPTER_COMMAND } from "./adapter-api";
import { loadAdapter } from "./adapter-loader";
import { attributionOf } from "./attribution";
import type { ErrorBoundary } from "./boundary";
import { handOff, shouldHandOff } from "./canary";
import { bundleVersion, checkSiteId, customParams, errorSampleRate, fetchConfig, gpcHonored, type SiteConfig } from "./config";
import {
  consentCommand,
  createLadder,
  honorGpc,
  watchConsentMode,
  watchCmpAdapters,
  watchTcf,
  type CmpHost,
  type ConsentInput,
  type ConsentModeHost,
  type GpcHost,
  type TcfHost,
} from "./consent-sources";
import { pageExitInput, watchEngagement, type EngagementHost, type PageExitInput } from "./engagement";
import { currentScript, endpointFromScript } from "./endpoint";
import { pageviewInput, watchRoutes, type PageSource, type PageviewInput, type RouteSource } from "./pageview";
import { ensureStub, installCommands, type AmandaHost, type Command } from "./queue";
import type { TagTarget } from "./telemetry";

/** The browser globals the tag boots on: window, or a stand-in for it in tests. */
export interface TagWindow extends AmandaHost, PageSource, RouteSource, ConsentModeHost, TcfHost, GpcHost, EngagementHost, CmpHost {
  readonly document: Document;
  readonly location: Location;
  readonly navigator: PageSource["navigator"] & GpcHost["navigator"];
  fetch: typeof fetch;
  /** popstate, pagehide and pageshow, and the events of the consent managers the tag has adapters for. */
  addEventListener(type: string, listener: () => void): void;
}

export interface BootOptions {
  readonly tagVersion: string;
  readonly boundary: ErrorBoundary;
  /** Where each pageview goes: the transport (createTransport), once identity and consent make it an event. */
  readonly onPageview: (input: PageviewInput) => void;
  /**
   * Where each page_exit goes (engagement.ts), as each pageview does: an event only, never a
   * ping. With it, the boot runs the engagement clock from the page's load, and hands over the
   * page_exits of hides after the tag booted. Without it, the tag tracks no engagement.
   */
  readonly onPageExit?: (input: PageExitInput) => void;
  /**
   * The consent state machine for the booted site's config (createConsent, with the config's
   * declined mode). With it, the consent sources drive the machine: Global Privacy Control when the
   * config honors it, the `consent` command, Google Consent Mode, TCF v2.2 and the adapters of
   * consent managers it detects, loaded from the endpoint (consent-sources.ts). Without
   * it, the tag follows no consent source.
   */
  readonly consent?: (config: SiteConfig) => ConsentInput;
  /** Filled in as the boot resolves the endpoint and the site, for the tag errors' sink. */
  readonly target?: TagTarget;
  readonly now?: () => number;
}

/** A booted tag: where it sends, for which site, and with what settings. */
export interface Tag {
  readonly endpoint: string;
  readonly site: string;
  readonly config: SiteConfig;
}

/**
 * Boots the tag on win. Call it synchronously at a.js's top level: it reads
 * document.currentScript, which is null anywhere else. Returns the boot's remaining, asynchronous
 * part, which settles with the booted tag, or undefined when the tag didn't boot: its failure was
 * reported, another copy of a.js already runs on the page, or the config pinned another build, which
 * has loaded to run in its place. It never rejects and never throws.
 */
export function boot(win: TagWindow, options: BootOptions): Promise<Tag | undefined> {
  const { boundary, target, onPageExit } = options;
  const now = options.now || Date.now;
  /** The page_exits' destination, once the tag booted; until then a page_exit is dropped. */
  let exitTo: ((engagementMs: number) => void) | undefined;
  /** The installing script tag, a <script> element once endpointFromScript has accepted it. */
  let script: Element | undefined;
  const started = boundary.guard("boot", () => {
    if (!ensureStub(win)) return undefined;
    if (onPageExit) watchEngagement(win, boundary, (engagementMs) => exitTo?.(engagementMs), now);
    const current = currentScript(win.document);
    const endpoint = endpointFromScript(current, win.location);
    // endpointFromScript has checked that current is a <script> element.
    script = current!;
    if (target) target.endpoint = endpoint;
    const site = checkSiteId(script.getAttribute("data-site"));
    if (target) target.site = site;
    return fetchConfig(win.fetch.bind(win), endpoint, site).then((config) => ({ endpoint, site, config }));
  });
  if (started === undefined) return Promise.resolve(undefined);
  /** Starts the booted tag: from here on, this build runs on the page. */
  const run = (tag: Tag): Tag => {
    if (onPageExit) {
      exitTo = (engagementMs) => onPageExit(pageExitInput(win, tag.site, options.tagVersion, engagementMs, now()));
    }
    return start(win, tag, options);
  };
  return started.then(
    (tag) =>
      boundary.guard("boot", () => {
        const rate = errorSampleRate(tag.config);
        if (rate !== undefined) boundary.setSampleRate(rate);
        const pin = bundleVersion(tag.config);
        if (!shouldHandOff(pin, options.tagVersion, script!)) return run(tag);
        // The pinned build boots in this one's place, with the stub this one left. When it fails to
        // load, the failure is reported and this build runs, so the page is still tracked.
        return handOff(win.document, script!, tag.endpoint, pin!, options.tagVersion, win.location.origin).then(
          () => undefined,
          (error: unknown) => {
            boundary.report("boot", error);
            return boundary.guard("boot", () => run(tag));
          },
        );
      }),
    (error: unknown) => {
      boundary.report("config", error);
      return undefined;
    },
  );
}

/**
 * Runs the booted tag: Global Privacy Control, when the site honors it, so that nothing grants
 * before it denies; Consent Mode's state as the dataLayer has it so far, the TCF consent manager's
 * when the page has one, the adapter of a consent manager the page has or loads later (Cookiebot, OneTrust, Usercentrics),
 * which signals once it has loaded and connected through the `adapter` command, then the site's queued
 * commands (they may set what the pageview carries, such as consent), then the first pageview,
 * the landing, which alone carries the landing URL's attribution (attribution.ts), then a pageview
 * on each route change.
 */
function start(win: TagWindow, tag: Tag, options: BootOptions): Tag {
  const { boundary, tagVersion, onPageview } = options;
  const now = options.now || Date.now;
  let lastUrl: string | undefined;
  const pageview = (): void => {
    boundary.guard("pageview", () => {
      const landing = lastUrl === undefined;
      const input = pageviewInput(win, tag.site, tagVersion, lastUrl === undefined ? win.document.referrer : lastUrl, now());
      lastUrl = input.url;
      const attribution = landing ? attributionOf(input.url, customParams(tag.config)) : undefined;
      onPageview(attribution === undefined ? input : { ...input, attribution });
    });
  };
  const commands: Record<string, Command> = { pageview };
  if (options.consent) {
    const ladder = createLadder(options.consent(tag.config));
    if (gpcHonored(tag.config)) boundary.guard("consent", () => honorGpc(win, ladder));
    boundary.guard("consent", () => watchConsentMode(win, boundary, ladder));
    boundary.guard("consent", () => watchTcf(win, boundary, ladder));
    const adapter = boundary.guard("consent", () =>
      watchCmpAdapters(win, boundary, ladder, (name) => loadAdapter(win.document, tag.endpoint, name, win.location.origin)),
    );
    if (adapter) commands[ADAPTER_COMMAND] = adapter;
    commands.consent = consentCommand(ladder);
  }
  installCommands(win, commands, boundary);
  pageview();
  watchRoutes(win, boundary, pageview);
  return tag;
}
