import { EXECUTION_CWD } from "./protocol";

/**
 * Chat figure capture: a matplotlib figure a run draws becomes a PNG file in
 * the working directory, so the existing output-files path (listing, upload to
 * the deliverable store, the persisted references) carries it with no new
 * persistence of its own.
 *
 * `plt.show()` is replaced by "save every open figure as figure-<n>.png, then
 * close it", and whatever is still open when the run ends is saved the same
 * way. `<n>` counts from 1 within each run, so the name is stable: a later
 * run's figure-1.png is a new version of the same file artifact. A figure the
 * code saved itself (`savefig`) is left out of the sweep: its own file is its
 * card. Earlier runs' figures stay in the working directory, for code that
 * wants them again; the run's listing only reports files changed since it
 * started.
 *
 * The Python lives here as a module body, run once per interpreter and
 * registered as `_cerea_figures` in `sys.modules`; nothing lands in the
 * person's own globals.
 */

/** Figures kept per run: a loop drawing a figure per row must not fill the store. */
export const MAX_FIGURES_PER_RUN = 20;

/** Code that mentions one of these is worth importing matplotlib for up front. */
const MATPLOTLIB_MENTION = /\b(matplotlib|pylab|seaborn)\b/;

export function mentionsMatplotlib(code: string): boolean {
	return MATPLOTLIB_MENTION.test(code);
}

const MODULE_BODY = `
import importlib.util
import os
import sys

_CWD = ${JSON.stringify(EXECUTION_CWD)}
_MAX = ${MAX_FIGURES_PER_RUN}
_state = {"n": 0, "capped": False, "patched": False}


def _save_open(plt):
    for num in list(plt.get_fignums()):
        if getattr(plt.figure(num), "_cerea_saved", False):
            # The code saved this figure itself: that file is its card.
            plt.close(num)
            continue
        if _state["n"] >= _MAX:
            plt.close(num)
            if not _state["capped"]:
                _state["capped"] = True
                sys.stderr.write(
                    "Only the first %d figures of a run are kept; later ones were discarded.\\n" % _MAX
                )
            continue
        _state["n"] += 1
        path = "%s/figure-%d.png" % (_CWD, _state["n"])
        try:
            plt.figure(num).savefig(path, format="png", bbox_inches="tight")
        except Exception as exc:
            sys.stderr.write("Could not save figure %s: %s\\n" % (num, exc))
        finally:
            plt.close(num)


def begin(import_matplotlib):
    _state.update(n=0, capped=False)
    os.environ["MPLBACKEND"] = "Agg"
    if not import_matplotlib or _state["patched"]:
        return
    if importlib.util.find_spec("matplotlib") is None:
        return
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def show(*args, **kwargs):
        _save_open(plt)

    plt.show = show

    # A figure the code saved itself already has its file; the sweep must not
    # turn the same image into a second card.
    from matplotlib.figure import Figure

    saved = Figure.savefig

    def savefig(self, *args, **kwargs):
        result = saved(self, *args, **kwargs)
        self._cerea_saved = True
        return result

    Figure.savefig = savefig
    _state["patched"] = True


def sweep():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        _save_open(plt)
`;

/** Runs once per interpreter, in a scratch namespace. */
export const FIGURES_SETUP_SOURCE = `
import sys
import types

if "_cerea_figures" not in sys.modules:
    _module = types.ModuleType("_cerea_figures")
    sys.modules["_cerea_figures"] = _module
    exec(${JSON.stringify(MODULE_BODY)}, _module.__dict__)
`;
