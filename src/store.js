// Application state with two kinds of subscribers: full (anything changed) and time (playhead only).
// The playhead moves many times a second during playback, so panels that only show time subscribe to time.

export function createStore(initial) {
  let state = initial;
  const full = new Set();
  const time = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      full.forEach((f) => f(state));
    },
    setTime(playhead) {
      state = { ...state, playhead };
      time.forEach((f) => f(state));
    },
    subscribe(f) {
      full.add(f);
      return () => full.delete(f);
    },
    subscribeTime(f) {
      time.add(f);
      return () => time.delete(f);
    },
  };
}
