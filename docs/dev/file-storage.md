# File storage: the blob-store seam

Every stored file (attachments and their extracted text, `execute_code`
deliverables, knowledge uploads, project documents, Office previews) goes
through `BlobStore` (`src/lib/server/blobs/`, reached as
`collections.blobStore`). **Never open a `GridFSBucket`, touch `files.files` /
`files.chunks` / `codeOutputs.*`, or build an S3 client outside that
directory**: `blobs/seam.spec.ts` fails the build if you do (only
`scripts/blobs-migrate.mjs` and the e2e seeders under `tests/` are exempt).

- Two buckets: `files` and `codeOutputs`. Ids are `ObjectId`s (the
  `gridFsId` field of `codeExecutionOutputs` keeps its old name and names a blob).
- Backends: `GridFsBlobStore` (default; its index rows are GridFS's own
  `<bucket>.files` documents, so existing data needs no migration) and
  `S3BlobStore` (`CHAT_BLOB_STORE=s3`; bytes at `<prefix><bucket>/<id>`, one row
  per blob in the `blobs` collection with the same field names as GridFS rows:
  `filename`, `length`, `uploadDate`, `metadata`).
- **Queries are Mongo filters over those rows** (`find`, `findOne`, `iterate`,
  `count`, `distinct`, `update`), never the backend's own metadata search, so a
  filter means the same on both. Put what you will query under `metadata.*`.
- Write order on S3: object first, then the row. Delete: object first, then
  the row, so a failed delete leaves the row for a retry or a sweep.
  `deleteMany` counts a blob already gone as deleted; `delete` of a missing one
  throws `BlobNotFoundError`.
- Settings are env-only (`CHAT_BLOB_STORE`, `CHAT_S3_*`; parsed and validated in
  `blobs/config.ts`) and the boot self-check (`selfCheck`, called from
  `Database.initDatabase`) refuses to start on a bad one.
- Specs: use `blobs/testing.ts` (`putBlob`, `findBlobs`, `countBlobs`,
  `removeBlobs`, `setUploadDate`) instead of reaching into collections. The
  contract suite runs on both backends (`TEST_S3_ENDPOINT` enables the S3
  half); run any server spec on S3 with `CHAT_BLOB_STORE=s3` and `CHAT_S3_*`
  (the server setup passes them through). CI does both against RustFS.
- S3 objects with no index row (a crash between the PUT and the row insert) are
  swept daily by `sweepOrphanObjects`, called from `sweepOrphanAttachments`
  (older than an hour, prefix listing: the credentials need `s3:ListBucket`).
  `deleteMany` falls back to per-object deletes if the store rejects
  `DeleteObjects`. Not built: pre-signed direct downloads (files are streamed
  through the app).
- The migration tool never copies while `CHAT_BLOB_STORE=s3` (a file deleted
  since the switch would come back): see the procedure in `docs/storage.md`.
- `docs/storage.md` is the operator page, including the migration procedure.
