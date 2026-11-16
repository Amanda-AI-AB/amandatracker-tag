// identify() (AAI-786; 01 §3, 04 §3): `amanda('identify', ref)` links the visitor to the site's own
// pseudonymous reference for its logged-in user, such as a hashed customer number, for logged-in
// stitching. The tag hands over one identify event carrying the ref as its user_ref; the processor
// stores it on the visitor and in the DSAR index (AAI-197). Only that event carries it: the tag keeps
// no ref, in memory or in a cookie, and a site calls identify on each page its user is logged in on.
//
// It is off by default: the command refuses unless the site's config turns it on
// (features.identify_enabled, a setting gated on the DPA addendum, AAI-197, AAI-198). An identify
// event is an event like a form_submit: it goes on the identified path alone, under granted
// analytics, and never becomes a ping, whose frozen field list has no user_ref.
//
// Tenants are told to send pseudonymous refs only, and the tag enforces it rather than trust the
// instruction: a ref holding an @, the shape of every email address, is refused before it leaves the
// browser, as the wire schema's UserRef and the collector refuse it too. So is a ref that isn't a
// string, is empty, or is over the schema's cap, which a cut would turn into another visitor's ref.
// A refusal is a CommandError, reported through the boundary; its message never quotes the ref.

import { TRACKED_EVENT_MAX_LENGTH, TRACKED_EVENT_PATTERN } from "../wire/generated";
import { compiledPattern, cutText } from "../wire/payload";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";
import { CommandError, type Command } from "./queue";

export const IDENTIFY_COMMAND = "identify";

/** The most characters a ref may have: the wire schema's UserRef cap. */
export const USER_REF_MAX_LENGTH = TRACKED_EVENT_MAX_LENGTH.user_ref;

/** An identify event's page fields, as pageviewInput reads them, and the site's ref. */
export interface IdentifyInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "identify";
  readonly user_ref: string;
}

/**
 * ref, checked as the header says: a non-empty string without an @, within USER_REF_MAX_LENGTH
 * characters. Throws CommandError otherwise, without quoting it.
 */
export function checkUserRef(ref: unknown): string {
  if (typeof ref !== "string" || ref === "") {
    throw new CommandError("amanda('identify', ref) takes the site's pseudonymous ref as a non-empty string");
  }
  if (ref.indexOf("@") >= 0) {
    throw new CommandError("amanda('identify', ref) refuses a ref holding an @, as an email address does: send a pseudonymous ref, such as a hashed customer number");
  }
  if (cutText(ref, USER_REF_MAX_LENGTH).length < ref.length) {
    throw new CommandError(`amanda('identify', ref) refuses a ref over ${USER_REF_MAX_LENGTH} characters`);
  }
  // The schema's own rule, should it ever ask more than the checks above.
  if (!compiledPattern(TRACKED_EVENT_PATTERN.user_ref).test(ref)) {
    throw new CommandError("amanda('identify', ref) refuses a ref the wire schema doesn't accept");
  }
  return ref;
}

/** The identify event of the page as it is now, with the site's ref; empty fields are left out. */
export function identifyInput(page: PageSource, site: string, tagVersion: string, ref: string, now: number = Date.now()): IdentifyInput {
  // A pageview's own fields stay with it: the identify event's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "identify", user_ref: ref };
}

/**
 * The `identify` command: refuses unless enabled, the site's config turning identify on, and refuses
 * a ref checkUserRef refuses; otherwise calls onIdentify with the ref, once per call.
 */
export function identifyCommand(enabled: boolean, onIdentify: (ref: string) => void): Command {
  return (...args: unknown[]) => {
    if (!enabled) throw new CommandError("amanda('identify') is off for this site: its config doesn't turn identify on");
    if (args.length !== 1) throw new CommandError("amanda('identify', ref) takes one argument, the site's pseudonymous ref");
    onIdentify(checkUserRef(args[0]));
  };
}
