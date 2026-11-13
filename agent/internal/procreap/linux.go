//go:build linux

package procreap

// The kernel ends the children with galopin (Pdeathsig).
const linuxPdeathsig = true
