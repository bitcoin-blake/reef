// Reef as a solid-apps registry App (hub-pod app interface): meta + render. The node runs inside the page in an iframe.
// Browsers partition a cross-site iframe's storage by the host page, so inside a host Reef has its own key and its own copy
// of the snapshot, separate from Reef opened directly; the page says so when it can tell, and offers to open Reef in a tab.
export const meta = {
  id: 'https://bitcoin-blake.github.io/reef/reef-app.js',
  name: 'Reef',
  icon: '🪢',
  description: 'A Knots-style Bitcoin node in a tab: the BLAKE2b testnet4 from a verified UTXO snapshot, every block validated in the page.',
};
export function render(container, ctx = {}) {
  container.innerHTML = '';
  const f = document.createElement('iframe');
  f.src = 'https://bitcoin-blake.github.io/reef/?embedded=1' + (ctx.params ? '&' + new URLSearchParams(ctx.params) : '');
  f.title = 'Reef'; f.allow = 'clipboard-write; clipboard-read'; f.style.cssText = 'width:100%;height:100%;min-height:640px;border:0;background:#d9dde3';
  container.appendChild(f);
  // File → Exit inside the pane asks the host to minimize it; a host with a dock can act on this, others ignore it
  const onMsg = (e) => { if (e.source === f.contentWindow && e.data?.source === 'reef' && e.data.type === 'minimize') ctx.minimize?.(); };
  addEventListener('message', onMsg);
  return () => { removeEventListener('message', onMsg); f.remove(); };
}
export default { meta, render };
