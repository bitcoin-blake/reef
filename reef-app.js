// Reef as a solid-apps registry App (hub-pod app interface): meta + render. The node runs inside the page in an
// iframe, so its storage (the snapshot in OPFS) belongs to Reef's own origin and one copy serves every host.
export const meta = {
  id: 'https://bitcoin-blake.github.io/reef/reef-app.js',
  name: 'Reef',
  icon: '🪢',
  description: 'A Knots-style Bitcoin node in a tab: the BLAKE2b testnet4 from a verified UTXO snapshot, every block validated in the page.',
};
export function render(container, ctx = {}) {
  container.innerHTML = '';
  const f = document.createElement('iframe');
  f.src = 'https://bitcoin-blake.github.io/reef/' + (ctx.params ? '?' + new URLSearchParams(ctx.params) : '');
  f.title = 'Reef'; f.allow = 'clipboard-write'; f.style.cssText = 'width:100%;height:100%;min-height:640px;border:0;background:#d9dde3';
  container.appendChild(f);
  return () => { f.remove(); };
}
export default { meta, render };
