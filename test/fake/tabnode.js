// A stand-in for blaketestnode's browser/tabnode.js, the page's only seam to the node: the smoke test serves it in place of the
// pinned file and drives the page with window.__fake.emit('message', {...}). start() holds the shared node lock as the real one does.
export const mib = (b) => `${(b / 1048576).toFixed(1)} MiB`;
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
export const n = (x) => Number(x).toLocaleString('en-US');
export function createTabNode() {
  const node = { phase: 'starting', hist: [], synced: false, mempool: null, error: null, height: null, st: null };
  const h = new Map();
  const on = (t, f) => {
    (h.get(t) ?? h.set(t, new Set()).get(t)).add(f);
    return () => h.get(t)?.delete(f);
  };
  const emit = (t, a) => {
    for (const f of h.get(t) ?? []) f(a);
  };
  const posts = [];
  const fake = (window.__fake = { node, emit, posts, starts: 0 });
  const start = async () => {
    fake.starts++;
    const got = await new Promise((res) =>
      navigator.locks.request('bitcoin-blake:node', { ifAvailable: true }, (l) => (res(!!l), l ? new Promise(() => {}) : null)),
    );
    if (!got) return false;
    await new Promise((r) => setTimeout(r, Number(window.__START_MS ?? 50)));
    return true;
  };
  return {
    node,
    on,
    emit,
    posts,
    opts: {},
    seeding: false,
    swarm: null,
    start,
    post: (m) => posts.push(m),
    followMempool() {},
    setTorrent() {},
    setSeed() {},
    wipe: async () => {},
    startSync() {},
    fileReady() {},
    seedStart() {},
    seedStop() {},
  };
}
