___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Amanda Tracker",
  "categories": ["ANALYTICS", "CONVERSIONS"],
  "brand": {
    "id": "brand_dummy",
    "displayName": "Amanda AI"
  },
  "description": "Loads the Amanda Tracker tag (a.js, the same script as the install snippet) and bridges Google Tag Manager's consent state into it. Fire it on the Initialization trigger, never a consent-gated one.",
  "containerContexts": ["WEB"]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "siteId",
    "displayName": "Site ID",
    "simpleValueType": true,
    "help": "Your site's public ID, as the Amanda portal shows it. Everything else comes from the site's own config.",
    "valueValidators": [
      { "type": "NON_EMPTY" },
      { "type": "REGEX", "args": ["^[A-Za-z0-9_-]{1,64}$"] }
    ]
  },
  {
    "type": "SELECT",
    "name": "eventType",
    "displayName": "Event type",
    "macrosInSelect": false,
    "selectItems": [
      { "value": "init", "displayValue": "Initialization: load the tag, which sends the pageview" },
      { "value": "event", "displayValue": "Custom event" },
      { "value": "purchase", "displayValue": "Purchase" }
    ],
    "simpleValueType": true,
    "defaultValue": "init",
    "help": "Fire the Initialization type on the Initialization - All Pages trigger. It sends the pageviews and follows consent. Never put it behind a consent-gated trigger: the tag decides what it may send itself, and gating it would turn off declined-mode pings."
  },
  {
    "type": "GROUP",
    "name": "customEvent",
    "displayName": "Custom event",
    "groupStyle": "NO_ZIPPY",
    "enablingConditions": [{ "paramName": "eventType", "paramValue": "event", "type": "EQUALS" }],
    "subParams": [
      {
        "type": "TEXT",
        "name": "eventName",
        "displayName": "Event name",
        "simpleValueType": true,
        "help": "Such as signup: at most 64 characters, and never the name of an event the tag sends itself (pageview, purchase, ...).",
        "valueValidators": [{ "type": "NON_EMPTY" }]
      },
      {
        "type": "SIMPLE_TABLE",
        "name": "eventProps",
        "displayName": "Event properties",
        "help": "At most 25. Each value is a string of at most 200 characters, a number or a boolean; pick a Data Layer Variable for it. A property whose variable is undefined is left out.",
        "simpleTableColumns": [
          { "defaultValue": "", "displayName": "Name", "name": "key", "type": "TEXT" },
          { "defaultValue": "", "displayName": "Value", "name": "value", "type": "TEXT" }
        ],
        "newRowButtonText": "Add property"
      }
    ]
  },
  {
    "type": "GROUP",
    "name": "purchaseGroup",
    "displayName": "Purchase",
    "groupStyle": "NO_ZIPPY",
    "enablingConditions": [{ "paramName": "eventType", "paramValue": "purchase", "type": "EQUALS" }],
    "subParams": [
      {
        "type": "TEXT",
        "name": "orderId",
        "displayName": "Order ID",
        "simpleValueType": true,
        "help": "Such as {{DLV - ecommerce.transaction_id}}. A reloaded confirmation page sends the same order again harmlessly: purchases are deduplicated by order.",
        "valueValidators": [{ "type": "NON_EMPTY" }]
      },
      {
        "type": "TEXT",
        "name": "revenue",
        "displayName": "Revenue",
        "simpleValueType": true,
        "help": "In the currency's major unit, such as 249.90. Such as {{DLV - ecommerce.value}}.",
        "valueValidators": [{ "type": "NON_EMPTY" }]
      },
      {
        "type": "TEXT",
        "name": "currency",
        "displayName": "Currency",
        "simpleValueType": true,
        "help": "ISO 4217, such as SEK. Such as {{DLV - ecommerce.currency}}.",
        "valueValidators": [{ "type": "NON_EMPTY" }]
      },
      {
        "type": "TEXT",
        "name": "items",
        "displayName": "Items (optional)",
        "simpleValueType": true,
        "help": "A variable holding the order's items as an array, such as {{DLV - ecommerce.items}}. GA4's item_id, item_name, quantity and price are read as sku, name, qty and price."
      }
    ]
  },
  {
    "type": "GROUP",
    "name": "advanced",
    "displayName": "Advanced settings",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      {
        "type": "TEXT",
        "name": "endpoint",
        "displayName": "Endpoint override",
        "simpleValueType": true,
        "help": "Leave empty to send to Amanda's collection host. Set it to the path of your own first-party proxy, such as /amnda, to send through your own site."
      },
      {
        "type": "CHECKBOX",
        "name": "consentBridge",
        "checkboxText": "Bridge Google Tag Manager's consent state into the tag",
        "simpleValueType": true,
        "defaultValue": true,
        "enablingConditions": [{ "paramName": "eventType", "paramValue": "init", "type": "EQUALS" }],
        "help": "Forwards analytics_storage, and ad_storage with ad_user_data, to amanda('consent', ...): each denial, and each change GTM reports. A consent type GTM has no state for is never forwarded as granted. Untick it when your site calls amanda('consent', ...) itself."
      }
    ]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

// Amanda Tracker: a loader and a consent bridge, never a second tracker. It injects the same a.js
// the install snippet loads, naming the site in the script's query (injectScript sets no
// attributes), and forwards Google Tag Manager's consent state and the tag's events to
// window.amanda, which queues them until a.js has loaded.
const addConsentListener = require('addConsentListener');
const callInWindow = require('callInWindow');
const createArgumentsQueue = require('createArgumentsQueue');
const encodeUriComponent = require('encodeUriComponent');
const getType = require('getType');
const injectScript = require('injectScript');
const isConsentGranted = require('isConsentGranted');
const logToConsole = require('logToConsole');
const makeNumber = require('makeNumber');
const makeString = require('makeString');
const makeTableMap = require('makeTableMap');

const TAG_URL = 'https://eu.serversider.com/a.js';

const fail = function (message) {
  logToConsole('Amanda Tracker: ' + message);
  data.gtmOnFailure();
};

// The consent bridge. GTM's isConsentGranted is true for a type that is granted and for one that
// has no state at all, so only its false, a type set to denied, is forwarded at once: a grant comes
// from a listener, which GTM calls only when a type it has a state for changes. ads is denied when
// ad_storage or ad_user_data is, and granted only when both are, as the tag reads Consent Mode.
const CONSENT_TYPES = ['analytics_storage', 'ad_storage', 'ad_user_data'];
const bridgeConsent = function () {
  const known = {};
  const forward = function () {
    const signal = {};
    let decided = false;
    if (known.analytics_storage) {
      signal.analytics = known.analytics_storage;
      decided = true;
    }
    if (known.ad_storage === 'denied' || known.ad_user_data === 'denied') {
      signal.ads = 'denied';
      decided = true;
    } else if (known.ad_storage === 'granted' && known.ad_user_data === 'granted') {
      signal.ads = 'granted';
      decided = true;
    }
    if (decided) callInWindow('amanda', 'consent', signal);
  };
  CONSENT_TYPES.forEach(function (type) {
    if (!isConsentGranted(type)) known[type] = 'denied';
    addConsentListener(type, function (consentType, granted) {
      known[consentType] = granted ? 'granted' : 'denied';
      forward();
    });
  });
  forward();
};

// GA4's item fields, read as the tag's own when an item doesn't have those.
const ITEM_FIELDS = [
  ['sku', 'item_id'],
  ['name', 'item_name'],
  ['qty', 'quantity'],
  ['price', 'price']
];
const purchaseItems = function (items) {
  return items.map(function (item) {
    const mapped = {};
    if (getType(item) !== 'object') return item;
    ITEM_FIELDS.forEach(function (field) {
      const value = item[field[0]] !== undefined ? item[field[0]] : item[field[1]];
      if (value !== undefined && value !== null) mapped[field[0]] = value;
    });
    return mapped;
  });
};

// Queues each call on window.amanda as the snippet's stub does; a.js runs them once it has loaded.
createArgumentsQueue('amanda', 'amanda.q');

if (data.eventType === 'event') {
  const props = data.eventProps && data.eventProps.length ? makeTableMap(data.eventProps, 'key', 'value') : undefined;
  callInWindow('amanda', 'event', data.eventName, props);
} else if (data.eventType === 'purchase') {
  const revenue = makeNumber(data.revenue);
  if (getType(revenue) !== 'number' || revenue !== revenue) {
    fail('Revenue is not a number');
    return;
  }
  const order = { order_id: makeString(data.orderId), revenue: revenue, currency: makeString(data.currency) };
  const itemsType = getType(data.items);
  if (itemsType === 'array') {
    order.items = purchaseItems(data.items);
  } else if (itemsType !== 'undefined' && itemsType !== 'null' && data.items !== '') {
    fail('Items is not an array');
    return;
  }
  callInWindow('amanda', 'purchase', order);
} else if (data.consentBridge !== false) {
  bridgeConsent();
}

let url = TAG_URL + '?site=' + encodeUriComponent(data.siteId);
if (data.endpoint) url = url + '&endpoint=' + encodeUriComponent(data.endpoint);
injectScript(url, data.gtmOnSuccess, function () {
  fail('a.js failed to load from ' + url);
}, 'amanda');


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "inject_script", "versionId": "1" },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [{ "type": 1, "string": "https://eu.serversider.com/a.js*" }]
          }
        }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "access_globals", "versionId": "1" },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "amanda" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "amanda.q" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "access_consent", "versionId": "1" },
      "param": [
        {
          "key": "consentTypes",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "consentType" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" }
                ],
                "mapValue": [
                  { "type": 1, "string": "analytics_storage" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "consentType" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" }
                ],
                "mapValue": [
                  { "type": 1, "string": "ad_storage" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "consentType" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" }
                ],
                "mapValue": [
                  { "type": 1, "string": "ad_user_data" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  },
  {
    "instance": {
      "key": { "publicId": "logging", "versionId": "1" },
      "param": [{ "key": "environments", "value": { "type": 1, "string": "debug" } }]
    },
    "clientAnnotations": { "isEditedByUser": true },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: Initialization loads a.js with the Site ID in its query
  code: |-
    runCode(mockData);

    assertApi('createArgumentsQueue').wasCalledWith('amanda', 'amanda.q');
    assertThat(injected).isEqualTo(['https://eu.serversider.com/a.js?site=site_123']);
    assertApi('gtmOnSuccess').wasCalled();
    assertApi('gtmOnFailure').wasNotCalled();
- name: The endpoint override goes in the query, encoded
  code: |-
    mockData.endpoint = '/amnda';
    runCode(mockData);

    assertThat(injected).isEqualTo(['https://eu.serversider.com/a.js?site=site_123&endpoint=%2Famnda']);
- name: A consent type set to denied is forwarded at once
  code: |-
    state.analytics_storage = false;
    state.ad_user_data = false;
    runCode(mockData);

    assertThat(calls).isEqualTo([['consent', {analytics: 'denied', ads: 'denied'}]]);
- name: Granted or unset consent is never forwarded as a grant
  code: |-
    runCode(mockData);

    assertThat(calls).isEqualTo([]);
- name: A change GTM reports is forwarded
  code: |-
    state.analytics_storage = false;
    state.ad_storage = false;
    state.ad_user_data = false;
    runCode(mockData);
    listeners.analytics_storage('analytics_storage', true);
    listeners.ad_storage('ad_storage', true);
    listeners.ad_user_data('ad_user_data', true);

    assertThat(calls).isEqualTo([
      ['consent', {analytics: 'denied', ads: 'denied'}],
      ['consent', {analytics: 'granted', ads: 'denied'}],
      ['consent', {analytics: 'granted', ads: 'denied'}],
      ['consent', {analytics: 'granted', ads: 'granted'}]
    ]);
- name: With the bridge off, consent is neither read nor forwarded
  code: |-
    state.analytics_storage = false;
    mockData.consentBridge = false;
    runCode(mockData);

    assertApi('isConsentGranted').wasNotCalled();
    assertApi('addConsentListener').wasNotCalled();
    assertThat(calls).isEqualTo([]);
- name: A custom event goes with its properties
  code: |-
    runCode({siteId: 'site_123', eventType: 'event', eventName: 'signup', eventProps: [{key: 'plan', value: 'pro'}]});

    assertThat(calls).isEqualTo([['event', 'signup', {plan: 'pro'}]]);
    assertApi('isConsentGranted').wasNotCalled();
    assertApi('gtmOnSuccess').wasCalled();
- name: A purchase maps GA4's items
  code: |-
    runCode({
      siteId: 'site_123', eventType: 'purchase', orderId: 1001, revenue: '249.9', currency: 'SEK',
      items: [{item_id: 'TSH-RED-M', item_name: 'T-shirt', quantity: 2, price: 124.95}]
    });

    assertThat(calls).isEqualTo([['purchase', {
      order_id: '1001', revenue: 249.9, currency: 'SEK',
      items: [{sku: 'TSH-RED-M', name: 'T-shirt', qty: 2, price: 124.95}]
    }]]);
- name: A purchase whose revenue is not a number fails, and loads nothing
  code: |-
    runCode({siteId: 'site_123', eventType: 'purchase', orderId: '1001', revenue: 'n/a', currency: 'SEK'});

    assertThat(calls).isEqualTo([]);
    assertThat(injected).isEqualTo([]);
    assertApi('gtmOnFailure').wasCalled();
- name: A.js failing to load fails the tag
  code: |-
    loads = false;
    runCode(mockData);

    assertApi('gtmOnFailure').wasCalled();
    assertApi('gtmOnSuccess').wasNotCalled();
setup: |-
  const mockData = {siteId: 'site_123', eventType: 'init', consentBridge: true};
  const injected = [];
  const calls = [];
  const listeners = {};
  const state = {};
  let loads = true;
  mock('injectScript', function (url, onSuccess, onFailure, cacheToken) {
    injected.push(url);
    if (loads) onSuccess(); else onFailure();
  });
  mock('callInWindow', function (name, command, a, b) {
    const call = [command, a];
    if (b !== undefined) call.push(b);
    calls.push(call);
  });
  mock('isConsentGranted', function (type) {
    return state[type] !== false;
  });
  mock('addConsentListener', function (type, listener) {
    listeners[type] = listener;
  });


___NOTES___

The Amanda Tracker's Google Tag Manager template (AAI-154). Its source of truth is template.tpl in
https://github.com/Amanda-AI-AB/amandatracker-tag, and test/gtm-template.test.ts runs its code
against the tag's real command queue and commands.
