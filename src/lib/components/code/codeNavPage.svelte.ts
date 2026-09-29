/**
 * A `page` whose URL changes after mount. The shared `$app/state` mock is a
 * plain object, so an address change made once a component is on screen is
 * never seen by it — a tree that reacts to navigation needs this one.
 */
export const livePage = $state({ url: new URL("http://localhost:3000/code"), data: {} });
