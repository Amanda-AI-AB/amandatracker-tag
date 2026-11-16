// The window.amanda command queue. The install snippet defines a stub that only queues its calls,
// so a site can call amanda(...) before a.js has loaded:
//
//   window.amanda = window.amanda || function () { (window.amanda.q = window.amanda.q || []).push(arguments); };
//
// Once the tag has its config, it replaces the stub with the real amanda(command, ...args), which
// runs each command inside the error boundary, and then runs the queued calls in the order they
// were made. Until then a.js keeps the stub (defining one itself when the snippet didn't), so calls
// made while the config loads queue too.

import type { ErrorBoundary } from "./boundary";

/** The function at window.amanda: the snippet's stub, with its queue, or the tag's own. */
export interface AmandaFunction {
  (...args: unknown[]): void;
  q?: ArrayLike<unknown>[];
  /** Set on the tag's own function, so a second copy of a.js on the page doesn't boot again. */
  loaded?: true;
}

export interface AmandaHost {
  amanda?: AmandaFunction | undefined;
}

export type Command = (...args: unknown[]) => void;

export class CommandError extends Error {
  override name = "CommandError";
}

/**
 * Makes sure window.amanda is a queueing stub, keeping the snippet's and its queue; false when a
 * copy of the tag already runs on the page, which this copy then leaves alone.
 */
export function ensureStub(win: AmandaHost): boolean {
  const existing = win.amanda;
  if (typeof existing === "function") return existing.loaded !== true;
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  return true;
}

/**
 * Replaces the stub with the tag's amanda(command, ...args), then runs the stub's queued calls, in
 * order. A call to a command not in `commands`, or one that throws, is reported through the
 * boundary and never throws into the caller.
 */
export function installCommands(win: AmandaHost, commands: Readonly<Record<string, Command>>, boundary: ErrorBoundary): void {
  const queued = win.amanda && win.amanda.q ? Array.prototype.slice.call(win.amanda.q) : [];
  const amanda: AmandaFunction = function (...args: unknown[]) {
    boundary.guard("command", () => run(commands, args));
  };
  amanda.loaded = true;
  win.amanda = amanda;
  for (const call of queued) {
    boundary.guard("command", () => run(commands, Array.prototype.slice.call(call as ArrayLike<unknown>)));
  }
}

function run(commands: Readonly<Record<string, Command>>, args: unknown[]): void {
  const name = args[0];
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(commands, name)) {
    throw new CommandError(`unknown command: ${String(name)}`);
  }
  commands[name]!(...args.slice(1));
}
