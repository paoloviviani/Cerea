package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"galopin/internal/mcpconn"
)

const connectorsUsage = `galopin connectors — the MCP servers this machine offers to the chat.

Usage:
  galopin connectors list [--creds PATH] [--state-dir PATH]
  galopin connectors test NAME [--creds PATH] [--state-dir PATH]
  galopin connectors login NAME [--creds PATH] [--state-dir PATH]

  list    Print each server of mcp.json: name, transport, state and whether
          this machine is signed in to it.
  test    Start the server, initialize it, list its tools (as the chat would
          see them, after allowedTools) and stop it.
  login   Sign in to an http or sse server that asks for OAuth: prints a URL
          and opens a browser; the redirect comes back to 127.0.0.1 on a
          random port. Tokens are kept 0600 in the state directory.

mcp.json lives in the state directory (default <config-dir>/galopin, beside
credentials.json; --state-dir, or the directory of --creds, changes it).
Variables like ${TOKEN} expand from this process's environment.
`

type connectorsOptions struct {
	creds, stateDir string
}

func runConnectors(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(os.Stderr, connectorsUsage)
		if len(args) == 0 {
			return exitError{code: 2, err: fmt.Errorf("a subcommand is required")}
		}
		return nil
	}
	sub, rest := args[0], args[1:]
	var name string
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		name, rest = rest[0], rest[1:]
	}
	fs := flagSetWithHelp("connectors "+sub, connectorsUsage)
	var opts connectorsOptions
	fs.StringVar(&opts.creds, "creds", "", "")
	fs.StringVar(&opts.stateDir, "state-dir", "", "")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if name == "" && fs.NArg() > 0 {
		name = fs.Arg(0)
	} else if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	dir, err := connectorsStateDir(&opts)
	if err != nil {
		return err
	}
	cfg := mcpconn.Config{Path: filepath.Join(dir, mcpConfigFileName), StateDir: dir, Logf: logf}
	switch sub {
	case "list":
		return connectorsList(cfg)
	case "test", "login":
		if name == "" {
			return fmt.Errorf("galopin connectors %s needs a server name", sub)
		}
		if sub == "test" {
			return connectorsTest(cfg, name)
		}
		return connectorsLogin(cfg, name)
	}
	return fmt.Errorf("unknown connectors subcommand %q\n\n%s", sub, connectorsUsage)
}

// connectorsStateDir is where mcp.json and the sign-ins live: --state-dir,
// else beside --creds, else the default state directory.
func connectorsStateDir(o *connectorsOptions) (string, error) {
	switch {
	case o.stateDir != "":
		return o.stateDir, nil
	case o.creds != "":
		return filepath.Dir(o.creds), nil
	}
	return defaultStateDir()
}

func connectorsList(cfg mcpconn.Config) error {
	entries, err := mcpconn.Load(cfg.Path, os.LookupEnv)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Printf("no servers in %s\n", cfg.Path)
		return nil
	}
	store := mcpconn.NewTokenStore(cfg.StateDir, nil)
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tTRANSPORT\tSTATE\tNOTE")
	for _, e := range entries {
		note := ""
		switch {
		case e.Invalid != "":
			note = e.Invalid
		case e.Transport != mcpconn.TransportStdio && store.Load(e.Name, e.URL) != nil:
			note = "signed in"
		case e.AllowedTools != nil:
			note = fmt.Sprintf("allowedTools: %d", len(e.AllowedTools))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", e.Name, e.Transport, e.State(), note)
	}
	return w.Flush()
}

func connectorsTest(cfg mcpconn.Config, name string) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	res, err := mcpconn.Check(ctx, cfg, name)
	if err != nil {
		return err
	}
	server := res.ServerName
	if server == "" {
		server = "(unnamed server)"
	}
	if res.ServerVersion != "" {
		server += " " + res.ServerVersion
	}
	fmt.Printf("%s: %s, protocol %s\n", name, server, res.Protocol)
	fmt.Printf("%d tool(s) offered: %s\n", len(res.Tools), strings.Join(res.Tools, ", "))
	return nil
}

func connectorsLogin(cfg mcpconn.Config, name string) error {
	entries, err := mcpconn.Load(cfg.Path, os.LookupEnv)
	if err != nil {
		return err
	}
	var entry *mcpconn.Entry
	for _, e := range entries {
		if e.Name == name {
			entry = e
		}
	}
	if entry == nil {
		return fmt.Errorf("no server named %q in %s", name, cfg.Path)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return mcpconn.Login(ctx, mcpconn.LoginOptions{
		Entry: entry, Store: mcpconn.NewTokenStore(cfg.StateDir, nil), Out: os.Stderr,
		OpenBrowser: func(u string) error { openBrowser(u); return nil }, Timeout: 5 * time.Minute,
	})
}
