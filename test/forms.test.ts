import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { formProps, watchForms, type FormHost, type FormSubmitInput } from "../src/core/forms";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "pings" } };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;

/** Each element's attributes, kept off the element so that reading one touches none of its properties. */
const attributes = new WeakMap<object, Record<string, string>>();

/** The page's HTMLFormElement: its prototype's getAttribute reads what attributes holds. */
class FakeFormElement {
  getAttribute(this: object, name: string): string | null {
    const own = attributes.get(this) ?? {};
    return Object.prototype.hasOwnProperty.call(own, name) ? own[name]! : null;
  }
}

/** A field of a form, with its name and its value as the visitor filled it in. */
interface Field {
  readonly name: string;
  readonly value: string;
}

/** The values a visitor typed into the populated form: none may leave the browser. */
const FIELDS: readonly Field[] = [
  { name: "email", value: "anna.svensson@example.se" },
  { name: "password", value: "hunter2-Secret!" },
  { name: "phone", value: "+46701234567" },
  { name: "message", value: "Please call me about my order 4711" },
  { name: "csrf", value: "tok_9f8e7d6c5b4a" },
];

/**
 * A form with attrs and populated fields. As in a browser, each field is also the form's property
 * of its name, so a field named id, name, action or getAttribute shadows the form's own.
 */
function populatedForm(attrs: Record<string, string>, fields: readonly Field[] = FIELDS): FakeFormElement {
  const form = new FakeFormElement();
  attributes.set(form, attrs);
  const elements = fields.map((field) => ({ ...field, type: "text" }));
  Object.assign(form, { elements, length: elements.length });
  for (const element of elements) Object.defineProperty(form, element.name, { value: element, enumerable: true });
  return form;
}

/** A booted tag with onFormSubmit on a window whose document the test submits forms on. */
function formPage(config: object = CONFIG) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(config));
  const submitListeners: { listener: (event: { target: unknown }) => void; options: AddEventListenerOptions | undefined }[] = [];
  Object.assign(win.document, {
    addEventListener: (type: string, listener: (event: { target: unknown }) => void, options?: AddEventListenerOptions) => {
      if (type === "submit") submitListeners.push({ listener, options });
    },
  });
  Object.assign(win, { HTMLFormElement: FakeFormElement });
  const reports: ErrorReport[] = [];
  const submits: FormSubmitInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    onFormSubmit: (input) => submits.push(input),
    now: () => START,
  });
  const submit = (target: unknown): void => {
    for (const { listener } of submitListeners) listener({ target });
  };
  return { win, booted, reports, submits, submit, submitListeners };
}

/** The wire event of a form_submit, once identity and consent have made it one. */
function wireEvent(input: FormSubmitInput) {
  return buildEvent({
    ...input,
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    consent: { analytics: "granted", ads: "granted" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("form_submit (AAI-170)", () => {
  it("sends the form's id, name and action, and no field data at all, from a populated form", async () => {
    const { booted, submits, submit, reports } = formPage();
    await booted;

    submit(populatedForm({ id: "contact", name: "contact-form", action: "/contact/send" }));

    expect(submits).toEqual([
      {
        type: "form_submit",
        site_id: "site_123",
        tag_version: "0.2.0",
        client_ts: START,
        url: `${PAGE}/products?id=1`,
        page_title: "Products",
        language: "sv-SE",
        props: { form_id: "contact", form_name: "contact-form", form_action: "/contact/send" },
      },
    ]);
    const event = wireEvent(submits[0]!);
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event.type).toBe("form_submit");
    expect(event.props).toEqual({ form_id: "contact", form_name: "contact-form", form_action: "/contact/send" });
    // The payload as it goes on the wire holds no field's value, and no field's name either.
    const payload = JSON.stringify(event);
    for (const field of FIELDS) {
      expect(payload).not.toContain(field.value);
      expect(payload).not.toContain(`"${field.name}"`);
    }
    expect(reports).toEqual([]);
  });

  it("reads nothing of the form but its three attributes, through the prototype's getAttribute", async () => {
    const { booted, submits, submit } = formPage();
    await booted;
    const read: PropertyKey[] = [];
    const form = new Proxy(populatedForm({ id: "signup", name: "newsletter", action: "/subscribe" }), {
      get(target, key, receiver) {
        read.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    attributes.set(form, { id: "signup", name: "newsletter", action: "/subscribe" });
    const getAttribute = vi.spyOn(FakeFormElement.prototype, "getAttribute");

    submit(form);

    expect(read).toEqual([]);
    expect(getAttribute.mock.calls.map(([name]) => name)).toEqual(["id", "name", "action"]);
    expect(submits[0]!.props).toEqual({ form_id: "signup", form_name: "newsletter", form_action: "/subscribe" });
    getAttribute.mockRestore();
  });

  it("is not fooled by fields named id, name, action or getAttribute, which shadow the form's own", async () => {
    const { booted, submits, submit } = formPage();
    await booted;
    const clobbering: Field[] = [
      { name: "id", value: "199001011234" },
      { name: "name", value: "Anna Svensson" },
      { name: "action", value: "delete-account" },
      { name: "getAttribute", value: "shadowing-field-value" },
    ];

    submit(populatedForm({ id: "profile", action: "/me" }, clobbering));

    expect(submits[0]!.props).toEqual({ form_id: "profile", form_action: "/me" });
    const payload = JSON.stringify(wireEvent(submits[0]!));
    for (const field of clobbering) expect(payload).not.toContain(field.value);
  });

  it("drops the action's query string and fragment", async () => {
    const { booted, submits, submit } = formPage();
    await booted;

    submit(populatedForm({ action: "https://shop.example.com/search?q=anna%40example.se&token=abc#results" }));

    expect(submits[0]!.props).toEqual({ form_action: "https://shop.example.com/search" });
  });

  it("leaves out the attributes a form lacks or has empty, and sends a bare form_submit for a form with none", async () => {
    const { booted, submits, submit } = formPage();
    await booted;

    submit(populatedForm({ id: "", name: "search" }));
    submit(populatedForm({}));
    submit(populatedForm({ action: "?only=query" }));

    expect(submits.map((s) => s.props)).toEqual([{ form_name: "search" }, undefined, undefined]);
    expect("props" in submits[1]!).toBe(false);
    const validate = validator("event.json");
    const events = submits.map(wireEvent);
    for (const event of events) expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(events.map((event) => event.props)).toEqual([{ form_name: "search" }, undefined, undefined]);
  });

  it("captures no field value whatever the config says: the tag has no allowlist to read", async () => {
    const config = {
      ...CONFIG,
      forms_enabled: true,
      form_fields: ["email", "phone"],
      capture_form_values: true,
      autocapture: { forms: { fields: ["email"], values: true } },
    };
    const { booted, submits, submit } = formPage(config);
    await booted;

    submit(populatedForm({ id: "contact" }));

    expect(submits[0]!.props).toEqual({ form_id: "contact" });
    const payload = JSON.stringify(wireEvent(submits[0]!));
    for (const field of FIELDS) expect(payload).not.toContain(field.value);
  });

  it("listens on the document in the capture phase, so a page that stops the event's propagation is still counted", async () => {
    const { booted, submitListeners } = formPage();
    await booted;

    expect(submitListeners).toHaveLength(1);
    expect(submitListeners[0]!.options).toEqual({ capture: true, passive: true });
  });

  it("ignores a submit event whose target isn't a form", async () => {
    const { booted, submits, submit, reports } = formPage();
    await booted;

    submit({ id: "not-a-form", getAttribute: () => "x" });
    submit(null);

    expect(submits).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("captures no form submission without onFormSubmit", async () => {
    const win: FakeWindow = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const added = vi.fn();
    Object.assign(win.document, { addEventListener: added });
    Object.assign(win, { HTMLFormElement: FakeFormElement });
    const boundary = new ErrorBoundary(() => undefined, 1);

    await boot(win, { tagVersion: "0.2.0", boundary, onPageview: () => undefined });

    expect(added).not.toHaveBeenCalled();
  });

  it("starts capturing only once the tag has booted", () => {
    const { submitListeners } = formPage();

    expect(submitListeners).toEqual([]);
  });

  it("reports a failure in the listener instead of throwing it into the page", () => {
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    let listener: (event: { target: unknown }) => void = () => undefined;
    const host: FormHost = {
      document: { addEventListener: (_type, l) => (listener = l) },
      HTMLFormElement: FakeFormElement,
    };
    watchForms(host, boundary, () => {
      throw new TypeError("boom");
    });

    expect(() => listener({ target: populatedForm({ id: "f" }) })).not.toThrow();
    expect(reports).toEqual([{ stage: "pageview", name: "TypeError", message: "boom" }]);
  });
});

describe("formProps", () => {
  const host: FormHost = { document: { addEventListener: () => undefined }, HTMLFormElement: FakeFormElement };

  it("sets no key but form_id, form_name and form_action", () => {
    const props = formProps(host, populatedForm({ id: "a", name: "b", action: "/c", method: "post", class: "x", "data-x": "y" }));

    expect(props).toEqual({ form_id: "a", form_name: "b", form_action: "/c" });
  });
});
