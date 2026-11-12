// Package browserrt carries the browser runtime (ADR 0116) inside the galopin binary: one
// bundled ES module and the package.json that pins its one external dependency. `galopin browser
// setup` writes them into galopin's own directory and installs from there. The bundle is built
// from browser-runtime/ by `npm run bundle`; a test fails when it is stale.
package browserrt

import _ "embed"

// Bundle is the runtime as one ES module (cerea-browser.mjs).
//
//go:embed cerea-browser.mjs
var Bundle []byte

// PackageJSON pins playwright-core, the dependency the bundle leaves external.
//
//go:embed package.json
var PackageJSON []byte
