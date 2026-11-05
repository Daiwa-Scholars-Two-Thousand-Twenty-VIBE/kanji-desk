// The local cache: IndexedDB in the browser, or plain memory for the demo.
// Both have the same methods:
//   getAll(store), putMany(store, items), add(store, item) -> key, remove(store, key),
//   getMeta(key), setMeta(key, value), wipe()
// Stores: subjects, assignments, review_statistics, study_materials, level_progressions (keyed by id),
// outbox (queued answers), history (finished items, this device only), meta (sync cursors, user).
(function (root) {
  "use strict";
  const DATA = ["subjects", "assignments", "review_statistics", "study_materials", "level_progressions"];
  const LOGS = ["outbox", "history"];
  const VERSION = 2; // 2 added level_progressions

  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  async function open(name) {
    const r = indexedDB.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of DATA) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      for (const s of LOGS) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    const db = await req(r);
    // A newer version of the app in another tab needs the database to upgrade: let it.
    db.onversionchange = () => db.close();
    const os = (store, mode) => db.transaction(store, mode).objectStore(store);
    return {
      getAll: (store) => req(os(store, "readonly").getAll()),
      async putMany(store, items) {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        for (const it of items) s.put(it);
        await done(tx);
      },
      add: (store, item) => req(os(store, "readwrite").add(item)),
      remove: (store, key) => req(os(store, "readwrite").delete(key)),
      async getMeta(key) {
        const row = await req(os("meta", "readonly").get(key));
        return row ? row.value : undefined;
      },
      setMeta: (key, value) => req(os("meta", "readwrite").put({ key, value })),
      async wipe() {
        const all = [...DATA, ...LOGS, "meta"];
        const tx = db.transaction(all, "readwrite");
        for (const s of all) tx.objectStore(s).clear();
        await done(tx);
      },
    };
  }

  function memory() {
    const stores = {};
    for (const s of [...DATA, ...LOGS]) stores[s] = new Map();
    const meta = new Map();
    let next = 1;
    return {
      getAll: async (store) => [...stores[store].values()],
      async putMany(store, items) {
        for (const it of items) stores[store].set(it.id, it);
      },
      async add(store, item) {
        const id = next++;
        stores[store].set(id, Object.assign({}, item, { id }));
        return id;
      },
      remove: async (store, key) => stores[store].delete(key),
      getMeta: async (key) => meta.get(key),
      setMeta: async (key, value) => meta.set(key, value),
      async wipe() {
        for (const s of Object.values(stores)) s.clear();
        meta.clear();
      },
    };
  }

  root.Store = { DATA, open, memory };
})(self);
