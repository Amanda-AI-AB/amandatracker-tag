// The consent state machine. Two categories, analytics and ads, each in one of four states:
// granted, denied, unknown (not decided yet) or no_cmp (the site has no consent manager). The
// analytics state decides how the tag collects:
//
//   granted                -> identified: events with the visitor and session ids (AAI-98);
//   denied                 -> declined: the site's declined mode, `pings` (anonymous pings,
//                             AAI-87) or `off` (nothing at all, AAI-86);
//   unknown                -> pending: items wait in memory, at most MAX_PENDING per page;
//   no_cmp                 -> as the site's no-CMP policy resolves it (AAI-94): identified when it
//                             resolves to granted, declined when to denied, pending until then.
//
// The ads state rides every event's consent snapshot and collects nothing by itself.
//
// Pending items go when the state is decided: with ids on a grant, per the declined mode on a
// denial, and per the declined mode on pagehide while still pending, so an `off` site drops them.
// Entering declined forgets the visitor (its cookies go at once) and withdraws the identified items
// the transport hasn't sent yet, so that under `off` a visitor who declined sends nothing at all
// from then on, not even what was collected before (AAI-86). A grant after a denial
// renews the ids, so the pings sent meanwhile are never linked to the visitor afterwards.
//
// The machine has no entry points of its own: its callers (the consent sources, AAI-85; the
// pageview and command feed, AAI-964; the pagehide listener) run it inside the error boundary.
// Register its pagehide before the transport's (createTransport), so that the pings it hands over
// leave with the transport's own pagehide flush.

import type { Consent, ConsentSource, ConsentState } from "../wire/generated";
import { warn } from "./boundary";

export type { Consent, ConsentSource, ConsentState };

/** A consent category. */
export type Category = "analytics" | "ads";

/** A consent signal: the categories it decides, and their states. */
export type ConsentSignal = Partial<Pick<Consent, Category>>;

/** What a site sends while analytics is denied: anonymous pings, or nothing (the default). */
export type DeclinedMode = "off" | "pings";

/** How the tag collects in the current state. */
export type CollectionMode = "identified" | "declined" | "pending";

/** What the site's no-CMP policy resolved to (AAI-94). Never assumed: an unresolved no_cmp waits. */
export type NoCmpDecision = "granted" | "denied";

/** The most items the pending buffer holds on one page; any more are dropped, with a warning. */
export const MAX_PENDING = 100;

const STATES: readonly ConsentState[] = ["granted", "denied", "unknown", "no_cmp"];
const CATEGORIES: readonly Category[] = ["analytics", "ads"];
const SOURCES: readonly ConsentSource[] = ["manual", "gcm"];

/** Where the machine hands each item, once the state says how it goes. */
export interface ConsentSink<T> {
  /** Collect item with the visitor's ids, under this snapshot. */
  identified(item: T, consent: Consent): void;
  /** Collect item as an anonymous ping: declined mode `pings` only. */
  anonymous(item: T): void;
  /**
   * Analytics was just denied: the identified items handed over but not sent yet never go
   * (Transport.withdrawEvents). Sent after the denial, they would be collection requests from a
   * visitor who declined, and their responses would set the cookies identity.forget() deleted.
   */
  withdraw(): void;
}

/** The visitor's identity (AAI-98), as the machine drives it. */
export interface IdentityControl {
  /** Deletes the visitor and session ids, cookies included, at once. */
  forget(): void;
  /** Mints fresh visitor and session ids, unrelated to any the visitor had before. */
  renew(): void;
}

export interface ConsentOptions<T> {
  readonly declinedMode: DeclinedMode;
  readonly sink: ConsentSink<T>;
  readonly identity: IdentityControl;
}

export interface ConsentMachine<T> {
  /** The current snapshot, a copy. */
  snapshot(): Consent;
  /** How items are collected now. */
  mode(): CollectionMode;
  /** The items waiting for a decision. */
  pendingCount(): number;
  /**
   * Applies a consent signal: the categories it names take their new states, the others keep
   * theirs, and the snapshot names `source` as its source from then on. Throws ConsentError,
   * changing nothing, on a category or a state off the lists. Which source may signal is the
   * ladder's to decide (consent-sources.ts), not the machine's.
   */
  update(signal: ConsentSignal, source?: ConsentSource): void;
  /** Applies the site's no-CMP policy's decision (AAI-94) to the categories in no_cmp. */
  resolveNoCmp(decision: NoCmpDecision): void;
  /** Collects item as the current mode says: identified, declined or pending. */
  collect(item: T): void;
  /** The page is going: pending items go per the declined mode, since no decision can follow. */
  pagehide(): void;
}

export class ConsentError extends Error {
  override name = "ConsentError";
}

/** The consent snapshot a fresh page starts from: nothing decided. */
export function initialConsent(): Consent {
  return { analytics: "unknown", ads: "unknown" };
}

/** The collection mode the analytics state gives, with no_cmp resolved by noCmp. */
export function collectionMode(analytics: ConsentState, noCmp: NoCmpDecision | undefined): CollectionMode {
  const effective = analytics === "no_cmp" ? noCmp : analytics;
  if (effective === "granted") return "identified";
  if (effective === "denied") return "declined";
  return "pending";
}

/** A consent signal checked: only the categories and states the wire schema lists. */
export function checkSignal(signal: unknown): ConsentSignal {
  if (typeof signal !== "object" || signal === null || Array.isArray(signal)) {
    throw new ConsentError("a consent signal is not an object");
  }
  const checked: ConsentSignal = {};
  for (const key of Object.keys(signal)) {
    if (CATEGORIES.indexOf(key as Category) < 0) throw new ConsentError(`unknown consent category: ${key}`);
    const state = (signal as Record<string, unknown>)[key];
    if (state === undefined) continue;
    if (STATES.indexOf(state as ConsentState) < 0) {
      throw new ConsentError(`consent ${key} is not one of ${STATES.join(", ")}: ${String(state)}`);
    }
    checked[key as Category] = state as ConsentState;
  }
  return checked;
}

/**
 * The consent state machine, starting with nothing decided (initialConsent). See the head of
 * this file for what each state does.
 */
export function createConsent<T>(options: ConsentOptions<T>): ConsentMachine<T> {
  const { declinedMode, sink, identity } = options;
  const consent = initialConsent();
  let noCmp: NoCmpDecision | undefined;
  let pending: T[] = [];
  let overflowWarned = false;
  // Whether the visitor declined on this page: a later grant then renews the ids.
  let declinedBefore = false;

  const current = (): CollectionMode => collectionMode(consent.analytics, noCmp);

  const decline = (item: T): void => {
    if (declinedMode === "pings") sink.anonymous(item);
  };

  const drain = (send: (item: T) => void): void => {
    const items = pending;
    pending = [];
    for (const item of items) send(item);
  };

  const transition = (from: CollectionMode): void => {
    const to = current();
    if (to === "declined" && from !== "declined") {
      declinedBefore = true;
      identity.forget();
      sink.withdraw();
    }
    if (to === "identified" && from !== "identified" && declinedBefore) identity.renew();
    if (to === "identified") drain((item) => sink.identified(item, { ...consent }));
    else if (to === "declined") drain(decline);
  };

  return {
    snapshot: () => ({ ...consent }),
    mode: current,
    pendingCount: () => pending.length,
    update(signal, source) {
      const checked = checkSignal(signal);
      if (source !== undefined && SOURCES.indexOf(source) < 0) {
        throw new ConsentError(`consent source is not one of ${SOURCES.join(", ")}: ${String(source)}`);
      }
      const from = current();
      for (const key of CATEGORIES) {
        const state = checked[key];
        if (state !== undefined) consent[key] = state;
      }
      if (source !== undefined) consent.source = source;
      transition(from);
    },
    resolveNoCmp(decision) {
      if (decision !== "granted" && decision !== "denied") {
        throw new ConsentError(`a no-CMP decision is granted or denied: ${String(decision)}`);
      }
      const from = current();
      noCmp = decision;
      transition(from);
    },
    collect(item) {
      const mode = current();
      if (mode === "identified") {
        sink.identified(item, { ...consent });
      } else if (mode === "declined") {
        decline(item);
      } else if (pending.length < MAX_PENDING) {
        pending.push(item);
      } else if (!overflowWarned) {
        // The cap is by design (02 §1), not a failure of the tag: logged, once per page.
        overflowWarned = true;
        warn(`amanda: consent is still undecided; ${MAX_PENDING} items wait already, so later ones are dropped`);
      }
    },
    pagehide() {
      if (current() === "pending") drain(decline);
    },
  };
}
