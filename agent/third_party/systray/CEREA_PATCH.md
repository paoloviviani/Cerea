# Patched copy of fyne.io/systray v1.12.2 (Apache-2.0)

One change, in `systray_darwin.m` `setIcon`: the menu-bar image keeps its aspect
ratio at 18 pt tall instead of being forced to 16x16, which squashed the
"Cerea connector" pixel-ridge icon. Used through a `replace` in `agent/go.mod`.
Drop this copy if upstream gains an aspect-preserving option.
