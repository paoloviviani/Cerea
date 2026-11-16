//go:build !unix

package main

// lockInstance has no non-unix implementation yet (see lock_other.go).
func lockInstance(credsPath string) (unlock func(), err error) {
	return func() {}, nil
}
