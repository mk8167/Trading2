/* A minimal but faithful chrome.* stub so the background modules can be
 * exercised in Node. Only the surfaces the extension actually touches are
 * implemented; anything else throws so an unnoticed API use shows up
 * loudly instead of silently doing nothing. */

const mem = { local: new Map(), session: new Map(), sync: new Map() };

const area = (map) => ({
  async get(keys) {
    if (keys == null) return Object.fromEntries(map);
    if (typeof keys === 'string') return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    }
    return {};
  },
  async set(obj) {
    for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
  },
  async remove(keys) {
    for (const k of [].concat(keys)) map.delete(k);
  },
  async clear() {
    map.clear();
  },
});

export const sentMessages = [];
export const notifications = [];
export const registeredScripts = [];
export const alarms = new Map();

export function install() {
  const listeners = { message: [], alarm: [], command: [], connect: [] };

  globalThis.chrome = {
    storage: {
      local: area(mem.local),
      session: area(mem.session),
      sync: area(mem.sync),
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: (msg) => {
        sentMessages.push(msg);
        return Promise.resolve({ ok: true });
      },
      getURL: (p) => `chrome-extension://stub/${p}`,
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      clear: (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    notifications: {
      create: (id, opts) => {
        notifications.push({ id, ...opts });
      },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      open: async () => {},
    },
    scripting: {
      registerContentScripts: async (list) => registeredScripts.push(...list),
      unregisterContentScripts: async () => {
        registeredScripts.length = 0;
      },
      getRegisteredContentScripts: async () => registeredScripts,
    },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: 'https://example.test/chart' }],
      sendMessage: async () => ({}),
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      getAll: async () => ({ origins: ['https://example.test/*'] }),
    },
    action: { onClicked: { addListener() {} } },
    debugger: { attach() {}, sendCommand() {}, onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  };

  return { listeners, mem };
}

export function reset() {
  mem.local.clear();
  mem.session.clear();
  mem.sync.clear();
  sentMessages.length = 0;
  notifications.length = 0;
  registeredScripts.length = 0;
  alarms.clear();
}
