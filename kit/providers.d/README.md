# providers.d: your own provider catalogue entries

Put `*.yaml` (or `*.yml`) files here to add to, or adjust, the gateway's
provider catalogue without editing a tracked file. The directory is mounted
read-only into the gateway at `/etc/pystino/providers.d`; the file format is
described on Pystino's provider-catalogue documentation page (in the gateway
docs, under Providers).

- Files are read when the gateway starts. After adding or changing one:
  `docker compose restart gateway`.
- An entry whose provider id matches a built-in one overrides it field by
  field; fields you leave out keep their built-in values. A new id adds a
  provider.
- No secrets here. Keys are set in the console and kept in the gateway's
  database, not in these files.

Git ignores `*.yaml` and `*.yml` in this directory, so an upgrade never
conflicts with yours. To keep the directory somewhere else, set
`PYSTINO_PROVIDERS_DIR` in `.env`.
