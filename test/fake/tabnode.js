// A stand-in for blaketestnode's browser/tabnode.js, the page's only seam to the node: the smoke test serves it in place of the
// pinned file and drives the page with window.__fake.emit('message', {...}). start() holds the shared node lock as the real one does.
export const mib = (b) => `${(b / 1048576).toFixed(1)} MiB`;
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
export const n = (x) => Number(x).toLocaleString('en-US');
// the real loader's rule (blaketestnode 670ad2b): a fault in the node's files is the node's error, whoever asked
export const storageFault = (m) =>
  /^(NotFoundError|NoModificationAllowedError|InvalidStateError|NotReadableError|QuotaExceededError)$/.test(m?.name ?? '');
export function createTabNode() {
  const node = { phase: 'starting', hist: [], synced: false, mempool: null, error: null, errorName: null, height: null, st: null };
  const h = new Map();
  const on = (t, f) => {
    (h.get(t) ?? h.set(t, new Set()).get(t)).add(f);
    return () => h.get(t)?.delete(f);
  };
  const emit = (t, a) => {
    // what the real loader does with a node message before the page sees it
    if (t === 'message' && a?.type === 'mempool') node.mempool = a;
    if (t === 'message' && a?.type === 'synced') {
      if (node.error && !/mismatch|FAILED/i.test(node.error)) Object.assign(node, { error: null, errorName: null }); // a sync clears it
      Object.assign(node, { synced: true, phase: 'synced', height: a.height, lastSync: Date.now(), time: Math.floor(Date.now() / 1000) });
    }
    // an error: a request's own answer while synced (by req, or a lookup's words), unless it is a fault in the node's files
    if (t === 'message' && a?.type === 'error' && !a.fatal) {
      const lookup =
        node.synced && !storageFault(a) && (a.req != null || /Block not found|sync first|not in the set|not in mempool/.test(a.text));
      if (!lookup) Object.assign(node, { error: a.text, errorName: a.name ?? null });
    }
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
    setSkew(s) {
      (window.__fake.skews ??= []).push(s);
    },
    wipe: async () => {},
    startSync() {},
    fileReady() {},
    seedStart() {},
    seedStop() {},
  };
}
