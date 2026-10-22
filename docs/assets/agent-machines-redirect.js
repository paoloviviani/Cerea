// The agent-machines page was split into "getting started" (agent-machines/)
// and "reference" (agent-machines-reference/). A link with an anchor that
// pointed into the old long page and now lives on the reference page would land
// at the top of the short page, so: on the getting-started page only, a hash
// that names no element here is sent to the same hash on the reference page.
(function () {
	var path = location.pathname;
	if (!/\/agent-machines(\/|\/index\.html)?$/.test(path)) return;
	var hash = location.hash;
	if (hash.length < 2) return;
	var id = decodeURIComponent(hash.slice(1));
	if (document.getElementById(id)) return;
	location.replace(path.replace(/agent-machines(\/index\.html|\/)?$/, "agent-machines-reference/") + hash);
})();
