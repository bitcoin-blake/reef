// A stand-in for sidestr's relay.mjs in the smoke test: everything is the real module (served at ?real) except the network.
// publish records the event in window.__relay and answers as one relay that took it; subscribe opens nothing.
export * from './relay.mjs?real';
export function publish({ event }) {
  (window.__relay ??= []).push(event);
  return Promise.resolve({ 'wss://relay.test': 'ok' });
}
export function subscribe() {
  return { close() {} };
}
