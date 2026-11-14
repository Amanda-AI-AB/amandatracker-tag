// The tag's boot: read the installing script tag, fetch the site's config, then install the
// command queue, send the first pageview and follow the single-page app's route changes. Every
// step runs inside the error boundary: a failure is reported, and the page never sees it.

import type { ErrorBoundary } from "./boundary";
import { checkSiteId, errorSampleRate, fetchConfig, type SiteConfig } from "./config";
import { consentCommand, createLadder, watchConsentMode, type ConsentInput, type ConsentModeHost } from "./consent-sources";
import { currentScript, endpointFromScript } from "./endpoint";
import { pageviewInput, watchRoutes, type PageSource, type PageviewInput, type RouteSource } from "./pageview";
import { ensureStub, installCommands, type AmandaHost, type Command } from "./queue";
import type { TagTarget } from "./telemetry";

/** The browser globals the tag boots on: window, or a stand-in for it in tests. */
export interface TagWindow extends AmandaHost, PageSource, RouteSource, ConsentModeHost {
  readonly document: Document;
  readonly location: Location;
  fetch: typeof fetch;
}

export interface BootOptions {
  readonly tagVersion: string;
  readonly boundary: ErrorBoundary;
  /** Where each pageview goes: the transport (createTransport), once identity and consent make it an event. */
  readonly onPageview: (input: PageviewInput) => void;
  /**
   * The consent state machine for the booted site's config (createConsent, with the config's
   * declined mode). With it, the consent sources drive the machine: the `consent` command and
   * Google Consent Mode (consent-sources.ts). Without it, the tag follows no consent source.
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
 * reported, or another copy of a.js already runs on the page. It never rejects and never throws.
 */
export function boot(win: TagWindow, options: BootOptions): Promise<Tag | undefined> {
  const { boundary, target } = options;
  const started = boundary.guard("boot", () => {
    if (!ensureStub(win)) return undefined;
    const script = currentScript(win.document);
    const endpoint = endpointFromScript(script, win.location);
    if (target) target.endpoint = endpoint;
    // endpointFromScript has checked that script is a <script> element.
    const site = checkSiteId(script!.getAttribute("data-site"));
    if (target) target.site = site;
    return fetchConfig(win.fetch.bind(win), endpoint, site).then((config) => ({ endpoint, site, config }));
  });
  if (started === undefined) return Promise.resolve(undefined);
  return started.then(
    (tag) =>
      boundary.guard("boot", () => {
        const rate = errorSampleRate(tag.config);
        if (rate !== undefined) boundary.setSampleRate(rate);
        return start(win, tag, options);
      }),
    (error: unknown) => {
      boundary.report("config", error);
      return undefined;
    },
  );
}

/**
 * Runs the booted tag: Consent Mode's state as the dataLayer has it so far, then the site's queued
 * commands (they may set what the pageview carries, such as consent), then the first pageview,
 * then a pageview on each route change.
 */
function start(win: TagWindow, tag: Tag, options: BootOptions): Tag {
  const { boundary, tagVersion, onPageview } = options;
  const now = options.now || Date.now;
  let lastUrl: string | undefined;
  const pageview = (): void => {
    boundary.guard("pageview", () => {
      const input = pageviewInput(win, tag.site, tagVersion, lastUrl === undefined ? win.document.referrer : lastUrl, now());
      lastUrl = input.url;
      onPageview(input);
    });
  };
  const commands: Record<string, Command> = { pageview };
  if (options.consent) {
    const ladder = createLadder(options.consent(tag.config));
    boundary.guard("consent", () => watchConsentMode(win, boundary, ladder));
    commands.consent = consentCommand(ladder);
  }
  installCommands(win, commands, boundary);
  pageview();
  watchRoutes(win, boundary, pageview);
  return tag;
}
