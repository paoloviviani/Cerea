# Machine protocol fixtures

Canonical JSON for every frame galopin and Cerea exchange (PROTOCOL.md, spec of
record). Both implementations test against these same files, so the two can no
longer drift unnoticed.

Each `*.json` file is `{"_meta": {...}, "frame": {...}}`. `frame` is exactly what
travels the WebSocket. `_meta` says where it comes from:

- `spec`: the PROTOCOL.md section (§5 framing, §6 operations and types, §7 events,
  §9 files, terminals and notices).
- `direction`: `M→C` (machine to Cerea) or `C→M`.
- `op`: for `res`, `callres` and `call` fixtures, the op the frame belongs to.
- `variant`: a second shape of the same frame (an older peer, a null, an empty list).
- `errorCode`: for error frames, the code.
- `null: true`: the frame carries a JSON null on purpose.
- `emittedByCurrentGo: false`: a shape only an older galopin sends (it must still be
  accepted, but is not re-marshalled from today's structs). `roundTrip: false`:
  decode-only.

## Layout

| Directory | Holds                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames/` | `hello` (current and an older machine), `welcome` (paired with features, pending without), `status`, `credential`, `auth`, the four `notice` kinds |
| `ops/`    | `<op>.req.json` and `<op>.res.json` for every op Cerea sends (plus `.req.<variant>` / `.res.<variant>`)                                            |
| `events/` | event envelopes (`{"type":"event",...}`), one per event kind and part type, with child-session, null and minimal variants                          |
| `calls/`  | machine calls: `schedule.*` `call` and `callres` frames, the `caller` facts, the six `callres` error codes                                         |
| `errors/` | one `res` error frame per error code (`not_found`, `invalid`, `forbidden`, `unavailable`, `backend`, `unsupported`, `conflict`, `too_large`)       |

PROTOCOL.md describes ops that neither side implements yet (`files.find`, `files.grep`,
`files.watch`, `files.unwatch`, `files.write`, and the `files.changed` watcher); they have
no fixtures until one does. `session.setAutoAccept` and `session.setRules` are retired and
answer `unsupported`.

## Who checks what

- Cerea: `src/lib/types/machineProtocol.fixtures.spec.ts` parses every machine-to-Cerea
  frame with `parseMachineFrame` and the zod schemas, feeds events and snapshots to the
  real timeline folding, round-trips delegate profiles and permission rules, and checks
  completeness against `OP_NAMES`, `NORMALIZED_EVENT_KINDS`, the frame-type lists,
  `MACHINE_CALL_OPS` and the error code lists in `machineProtocol.ts`.
- galopin: `protocol_fixtures_test.go` decodes every fixture into the real Go structs with
  `DisallowUnknownFields`, re-marshals and compares, runs every `req` through the real
  `machine.Handle`, builds Go values with nothing optional set and compares their JSON, and
  enumerates the code (the `Handle` switch, the `EventKind` constants, the frame writers and
  readers in `internal/link`, the schedule call ops, the codes `opErrf` emits) from source.
  `internal/link/fixtures_test.go` drives a real Link against a fake Cerea with the
  frames.

## The rule

A protocol change updates the fixtures, in the same commit: a new op, event kind, frame
type, error code or field needs a fixture on both sides' checks before it merges, and the
completeness tests fail until it has one. The files are written by hand from PROTOCOL.md
and the code, not generated from either implementation.
