// amanda('event', name, props) (AAI-979; 01 §4): the site's own custom event, such as a signup, and
// the command the GTM Community Template's custom event type forwards to (AAI-154):
//
//   amanda('event', 'signup', { plan: 'pro', seats: 3, trial: true })
//
// It hands over one event whose type is the name, carrying props as its props: a TrackedEvent of the
// wire schema (schema/v1/event.json), whose type is any EventType but the three a branch of their own
// carries. The name is a non-empty string of at most 64 characters (EventType's cap), and never the
// type of an event the tag sends itself (TAG_EVENT_TYPES): a site's "pageview" would count as one.
// props, when given, is a flat object of at most 25 keys (Props), none empty or starting with am_,
// each value a string of at most 200 characters, a finite number or a boolean; a key whose value is
// undefined is left out, as JSON leaves it out, so a GTM variable that isn't set sends nothing.
//
// Both are checked here, before anything is handed over: what the collector would refuse is refused
// in the browser instead, with a CommandError reported through the boundary that names the argument
// or the key and never quotes a value. Nothing is cut or coerced: a value over its cap, which the
// payload builder would cut, is refused, so the site learns its call isn't sent as it made it.
//
// A custom event is an event only, as a form_submit is: it goes under granted analytics, is held
// while consent is undecided, and never becomes a ping, in either declined mode. The ping's frozen
// field list (08 G2) has no props, and its type would carry the site's free-text name from a
// browser whose visitor declined, which counsel's list doesn't cover.

import { PROPS_MAP, TRACKED_EVENT_MAX_LENGTH, TRACKED_EVENT_PATTERN, type Props } from "../wire/generated";
import { compiledPattern, cutText } from "../wire/payload";
import { isRecord } from "./guards";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";
import { CommandError, type Command } from "./queue";

export const EVENT_COMMAND = "event";

/** The most characters a custom event's name may have: the wire schema's EventType cap. */
export const EVENT_NAME_MAX_LENGTH = TRACKED_EVENT_MAX_LENGTH.type;

/**
 * The types of the events the tag sends itself, which a custom event's name may not take: the
 * collector and the processor would count it as one of them.
 */
export const TAG_EVENT_TYPES: readonly string[] = [
  "pageview",
  "page_exit",
  "form_submit",
  "click_special",
  "click_outbound",
  "scroll",
  "identify",
  "purchase",
  "view_item",
  "add_to_cart",
  "begin_checkout",
];

/** A custom event's page fields, as pageviewInput reads them, its name as its type, and its props. */
export interface CustomEventInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: string;
  readonly props?: Props;
}

/** A custom event as the command accepts it: its name, and its props when it has any. */
export interface CustomEvent {
  readonly name: string;
  readonly props?: Props;
}

const USAGE = "amanda('event', name, props)";

/** Whether value is longer than cap characters, counted by code point, as JSON Schema counts them. */
function overCap(value: string, cap: number): boolean {
  return cutText(value, cap).length < value.length;
}

/**
 * name, checked as the header says: a non-empty string within EVENT_NAME_MAX_LENGTH characters that
 * no event of the tag's own has as its type. Throws CommandError otherwise, without quoting it.
 */
export function checkEventName(name: unknown): string {
  if (typeof name !== "string" || name === "") throw new CommandError(`${USAGE} takes the event's name as a non-empty string`);
  if (overCap(name, EVENT_NAME_MAX_LENGTH)) throw new CommandError(`${USAGE} refuses a name over ${EVENT_NAME_MAX_LENGTH} characters`);
  if (TAG_EVENT_TYPES.indexOf(name) >= 0) throw new CommandError(`${USAGE} refuses the name ${name}: the tag sends that event itself`);
  // The schema's own rule, should it ever ask more than the checks above.
  if (!compiledPattern(TRACKED_EVENT_PATTERN.type).test(name)) throw new CommandError(`${USAGE} refuses a name the wire schema doesn't accept`);
  return name;
}

/**
 * props, checked as the header says, as a copy without the keys whose value is undefined. Throws
 * CommandError on anything else, naming the key and never quoting its value.
 */
export function checkProps(props: unknown): Props {
  if (!isRecord(props)) throw new CommandError(`${USAGE} takes props as a flat object`);
  const given = props;
  const keyPattern = compiledPattern(PROPS_MAP.keyPattern);
  const kept: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const key of Object.keys(given)) {
    const value = given[key];
    if (value === undefined) continue;
    if (!keyPattern.test(key)) throw new CommandError(`${USAGE} refuses the props key "${key}": keys are not empty and never start with am_`);
    if (++count > PROPS_MAP.maxProperties) throw new CommandError(`${USAGE} refuses props of more than ${PROPS_MAP.maxProperties} keys`);
    if (typeof value === "string") {
      if (overCap(value, PROPS_MAP.maxLength)) {
        throw new CommandError(`${USAGE} refuses props.${key}: a string over ${PROPS_MAP.maxLength} characters`);
      }
    } else if (!(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
      throw new CommandError(`${USAGE} refuses props.${key}: not a string, a finite number or a boolean`);
    }
    kept[key] = value;
  }
  return kept;
}

/** The custom event of the page as it is now, with its name and props; empty fields are left out. */
export function customEventInput(page: PageSource, site: string, tagVersion: string, event: CustomEvent, now: number = Date.now()): CustomEventInput {
  // A pageview's own fields stay with it: the event's name replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return event.props === undefined ? { ...fields, type: event.name } : { ...fields, type: event.name, props: event.props };
}

/**
 * The `event` command: takes a name and, optionally, props; refuses what checkEventName or checkProps
 * refuses; otherwise calls onEvent with them, once per call, without props when none are left.
 */
export function eventCommand(onEvent: (event: CustomEvent) => void): Command {
  return (...args: unknown[]) => {
    if (args.length < 1 || args.length > 2) throw new CommandError(`${USAGE} takes the event's name and, optionally, its props`);
    const name = checkEventName(args[0]);
    const props = args[1] === undefined ? {} : checkProps(args[1]);
    onEvent(Object.keys(props).length === 0 ? { name } : { name, props });
  };
}
