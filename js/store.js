/* Local persistence (IndexedDB). Projects, their images (as Blobs), results and the registered image stay on this device. */
const DB = 'stardust', STORE = 'projects';
let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode), s = t.objectStore(STORE), q = fn(s); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };

export const Store = {
  async all() { const list = (await tx('readonly', s => s.getAll())) || []; return list.sort((a, b) => b.updated - a.updated); },
  get: (id) => tx('readonly', s => s.get(id)),
  put: (p) => { p.updated = Date.now(); const c = Object.assign({}, p); for (const r of ['src', 'ref']) if (c[r]) { c[r] = Object.assign({}, c[r]); delete c[r]._url; } return tx('readwrite', s => s.put(c)); },
  del: (id) => tx('readwrite', s => s.delete(id)),
  clear: () => tx('readwrite', s => s.clear()),
  async usage() { try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage, quota: e.quota } : null; } catch { return null; } }
};

export const Prefs = {
  get(k, d) { try { const v = localStorage.getItem('stardust.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stardust.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};
