// Autocapture of form submissions (01 §4): a form_submit for each submit event a form fires,
// carrying the form's id, name and action, and nothing else of it. Field values are never read:
// the tag never touches a form's fields, and there is no allowlist and no config that could make
// it, which is the point (08 I4, R5).
//
// The three are read as the form's attributes through HTMLFormElement.prototype's getAttribute,
// never as the form's properties: a field named id, name, action or getAttribute shadows the
// property of that name on its form, and would hand the tag the field instead. The action loses its
// query string and fragment, which can carry a token or an email address the page put there.
//
// The listener is on the document in the capture phase, so that a page that stops the submit
// event's propagation still has it counted. A submission the page cancels (an Ajax form) is a
// submission too. form.submit() fires no submit event, so it sends no form_submit.

import { stripFrom } from "../wire/payload";
import type { ErrorBoundary } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";

/**
 * The props a form_submit carries, those its form has: no other key is ever set. A type, not an
 * interface, so that it is assignable to the wire's Props map.
 */
export type FormSubmitProps = {
  readonly form_id?: string;
  readonly form_name?: string;
  readonly form_action?: string;
};

/** A form_submit's page fields, as pageviewInput reads them, and its form's props, when it has any. */
export interface FormSubmitInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "form_submit";
  readonly props?: FormSubmitProps;
}

/** What the form watcher listens on: window, or a stand-in for it in tests. */
export interface FormHost {
  readonly document: {
    addEventListener(type: "submit", listener: (event: { readonly target: unknown }) => void, options?: AddEventListenerOptions): void;
  };
  /** The page's HTMLFormElement: what tells a form from another target, and its getAttribute. */
  readonly HTMLFormElement: (abstract new () => object) & { readonly prototype: Pick<HTMLFormElement, "getAttribute"> };
}

/**
 * The props of form: its id, name and action attributes, those that aren't empty, the action
 * without its query string and fragment. Reads nothing else of the form.
 */
export function formProps(host: FormHost, form: object): FormSubmitProps {
  const attribute = (name: string): string => host.HTMLFormElement.prototype.getAttribute.call(form, name) || "";
  const props: { -readonly [K in keyof FormSubmitProps]: FormSubmitProps[K] } = {};
  const id = attribute("id");
  if (id !== "") props.form_id = id;
  const name = attribute("name");
  if (name !== "") props.form_name = name;
  const action = stripFrom(attribute("action"), "?#");
  if (action !== "") props.form_action = action;
  return props;
}

/**
 * The form_submit of the page as it is now, with the form's props; empty fields are left out, and
 * so are props a form with none of the three attributes leaves empty.
 */
export function formSubmitInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  props: FormSubmitProps,
  now: number = Date.now(),
): FormSubmitInput {
  // A pageview's own fields stay with it: the form_submit's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return Object.keys(props).length === 0 ? { ...fields, type: "form_submit" } : { ...fields, type: "form_submit", props };
}

/**
 * Calls onSubmit with the props of each form that fires a submit event, as the file's header says.
 * A submit event whose target isn't a form, which only a page's script can dispatch, is ignored.
 * The listener runs inside the boundary, as stage "pageview": a form_submit belongs to the page's
 * view, as a page_exit does.
 */
export function watchForms(win: FormHost, boundary: ErrorBoundary, onSubmit: (props: FormSubmitProps) => void): void {
  win.document.addEventListener(
    "submit",
    (event) =>
      boundary.guard("pageview", () => {
        const form = event.target;
        if (!(form instanceof win.HTMLFormElement)) return;
        onSubmit(formProps(win, form));
      }),
    { capture: true, passive: true },
  );
}
