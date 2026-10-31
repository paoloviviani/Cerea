# File storage

Cerea keeps the files it handles in one place, called the blob store: message
attachments and the text read out of them, files the assistant produces,
knowledge-base uploads, project documents and Office previews. What goes in
MongoDB regardless (conversations, settings, the index of files) is unchanged.

There are two backends. You choose one for the whole deployment with
environment variables; there is no screen for it, because where bytes live is
an operator decision.

| Backend              | Setting                            | What it is                                                                                                                                                        |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GridFS** (default) | `CHAT_BLOB_STORE=gridfs`, or unset | Files inside MongoDB, as Cerea has always kept them. Nothing to run or configure.                                                                                 |
| **S3**               | `CHAT_BLOB_STORE=s3`               | Files in a bucket of any S3-compatible store: AWS S3, Cloudflare R2, Backblaze B2, MinIO, Ceph, or RustFS, which the [deploy kit](deploy-kit.md) can run for you. |

Use GridFS unless you have a reason not to. Reasons for S3: your MongoDB is
small or managed and you do not want large files in it, you already run object
storage with its own replication and lifecycle, or you want files to survive
independently of the database.

## How it works

Every question Cerea asks about a file (which files belong to this
conversation, which uploads are older than a day, which previews name this
file) is answered from a record in MongoDB, never by the storage backend's own
search. With GridFS that record is GridFS's own file document, so an existing
database needs no migration to keep working. With S3 it is a document in the
`blobs` collection, written beside the object and removed with it. Object keys
are `<prefix><bucket>/<id>`; they contain no name, owner or conversation.

Bytes are streamed in and out; large files are uploaded in parts. Downloads are
served through the chat, as they always were, so the browser never talks to the
bucket and the bucket needs no public access and no CORS configuration.
(Direct downloads through pre-signed URLs are possible later; they are not
built.)

At start the chat checks the store: it validates the settings, reaches the
bucket, and writes, reads and deletes a small probe object under your prefix. A
setting that is wrong, a bucket that is missing or credentials that are refused
stop the chat from starting, with the reason in the log, rather than failing on
a user's first upload.

## Settings (S3)

All are environment variables of the chat (in the kit, `.env`).

| Variable                                             | Meaning                                                                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_BLOB_STORE`                                    | `gridfs` (default) or `s3`.                                                                                                                                                            |
| `CHAT_S3_ENDPOINT`                                   | The store's URL, for example `https://s3.eu-central-003.backblazeb2.com`. Empty means AWS S3.                                                                                          |
| `CHAT_S3_REGION`                                     | The region. Required on AWS; elsewhere it defaults to `us-east-1`, which most stores accept whatever they call theirs.                                                                 |
| `CHAT_S3_BUCKET`                                     | The bucket. It must exist unless `CHAT_S3_CREATE_BUCKET=true`.                                                                                                                         |
| `CHAT_S3_ACCESS_KEY_ID`, `CHAT_S3_SECRET_ACCESS_KEY` | The keys. Set both or neither: with neither, the standard AWS credential chain is used (environment, shared files, an instance or task role).                                          |
| `CHAT_S3_FORCE_PATH_STYLE`                           | `true` addresses the bucket as `host/bucket/key`, which self-hosted stores need; `false` as `bucket.host/key`, which AWS uses. Default `true` when an endpoint is set, `false` on AWS. |
| `CHAT_S3_PREFIX`                                     | A key prefix, for example `cerea/`, to share one bucket between deployments.                                                                                                           |
| `CHAT_S3_SSE`                                        | Server-side encryption: `AES256`, or `aws:kms` (with `CHAT_S3_SSE_KMS_KEY_ID` to name the key). Empty leaves it to the bucket's default.                                               |
| `CHAT_S3_CREATE_BUCKET`                              | `true` creates the bucket at start when it does not exist. The kit sets it for its own RustFS.                                                                                         |

The credentials need to put, get, head and delete objects under the prefix,
and, with `CHAT_S3_CREATE_BUCKET`, to create the bucket. Listing is not needed.

### Examples

AWS S3, credentials from the instance role:

```sh
CHAT_BLOB_STORE=s3
CHAT_S3_REGION=eu-west-1
CHAT_S3_BUCKET=example-cerea-files
CHAT_S3_PREFIX=prod/
CHAT_S3_SSE=AES256
```

Cloudflare R2 (the endpoint carries your account id; the region is `auto` or
left to the default):

```sh
CHAT_BLOB_STORE=s3
CHAT_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CHAT_S3_BUCKET=cerea-files
CHAT_S3_ACCESS_KEY_ID=...
CHAT_S3_SECRET_ACCESS_KEY=...
```

Backblaze B2 (use the endpoint and region shown on the bucket's page):

```sh
CHAT_BLOB_STORE=s3
CHAT_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
CHAT_S3_REGION=eu-central-003
CHAT_S3_BUCKET=cerea-files
CHAT_S3_ACCESS_KEY_ID=...
CHAT_S3_SECRET_ACCESS_KEY=...
```

MinIO, Ceph or any other self-hosted store:

```sh
CHAT_BLOB_STORE=s3
CHAT_S3_ENDPOINT=https://minio.internal.example:9000
CHAT_S3_BUCKET=cerea
CHAT_S3_ACCESS_KEY_ID=...
CHAT_S3_SECRET_ACCESS_KEY=...
# path-style is the default with an endpoint; set CHAT_S3_FORCE_PATH_STYLE=false
# only for a store that requires bucket.host addressing
```

RustFS, bundled with the deploy kit: `./configure --object-store && docker
compose up -d` (see [the kit](deploy-kit.md#object-storage-for-files-rustfs-profile)).

!!! note "Path-style or virtual-hosted"
Virtual-hosted style (`bucket.host`) needs a wildcard DNS name and, over
HTTPS, a wildcard certificate, which self-hosted stores rarely have. If a
store answers "bucket not found" or fails TLS with a name like
`cerea.minio.internal`, you want path style.

## Moving an existing deployment from GridFS to S3

Never change `CHAT_BLOB_STORE` on a deployment that already holds files
without copying them: the chat would look for them in the bucket and find
nothing. The migration tool, `scripts/blobs-migrate.mjs`, is in the chat image.
It copies every GridFS file to the bucket under the same id, with the same
name, size, date and metadata, so every reference stays valid. It is
idempotent and resumable, and it never deletes anything unless you ask.

1. **Back up** MongoDB (see the kit's Backup and restore).
2. **Set the target** in the environment but leave `CHAT_BLOB_STORE` alone for
   now: the `CHAT_S3_*` variables, and the bucket created (or
   `CHAT_S3_CREATE_BUCKET=true`). Restart the chat so the container sees them.
3. **Dry run.** It counts what would be copied and writes nothing:

   ```sh
   docker compose exec chat node scripts/blobs-migrate.mjs --dry-run
   ```

4. **Copy.** Users can keep working; the chat is still on GridFS:

   ```sh
   docker compose exec chat node scripts/blobs-migrate.mjs --verify
   ```

   It prints progress, and a summary: copied, already there, failed. A file
   that fails is reported with its id and the reason; the exit status is 1.
   Fix the cause and run it again: files already copied are skipped.

5. **Switch.** Set `CHAT_BLOB_STORE=s3` and restart the chat (in the kit:
   `docker compose up -d`). The start-up check must pass.
6. **Catch up.** Files uploaded between step 4 and the restart are still only in
   GridFS. Run the copy once more; it copies just those:

   ```sh
   docker compose exec chat node scripts/blobs-migrate.mjs --verify
   ```

7. **Verify** in the app: open an old conversation with an attachment, download a
   generated file, open a knowledge-base document. Nothing should be missing.
8. **Clean up**, once you are satisfied and have a backup of the bucket. This
   reads both copies back, compares size and sha256, and deletes each GridFS
   copy only after its own comparison succeeded:

   ```sh
   docker compose exec chat node scripts/blobs-migrate.mjs --delete-source
   ```

   MongoDB then keeps the index and nothing else. Its disk space comes back
   after a compaction or an initial sync of a replica; plan for that.

Options: `--bucket files|codeOutputs|all` (default all), `--concurrency N`
(default 4), `--verify` (compare sha256 of both copies; implied by
`--delete-source`).

There is no automated way back. To return to GridFS, copy the files back by
hand or restore the backup from step 1.

## Backups

With S3, the bytes live in the bucket and MongoDB holds their index: back up
**both** from the same moment, or use the store's own replication and
versioning for the bucket. With the kit's bundled RustFS, add the `rustfs-data`
volume to your backup. A restored MongoDB whose index names files the bucket no
longer has shows those files as missing; a bucket with objects the index does
not know is harmless but wastes space.

## For developers

Every new place that stores or reads a file goes through `collections.blobStore`
(`src/lib/server/blobs/`): `put`, `open`, `read`, `stat`, `find`, `update`,
`delete`. Code never opens a `GridFSBucket` or an S3 client itself; a test
(`seam.spec.ts`) fails the build if it does. Queries over files are Mongo
filters over `filename`, `length`, `uploadDate` and `metadata.*`.

Run the specs against S3 with a local RustFS:

```sh
docker run -d --name rustfs -p 127.0.0.1:19000:9000 \
  -e RUSTFS_ACCESS_KEY=testkey -e RUSTFS_SECRET_KEY=testsecret12345 \
  --tmpfs /data:uid=10001,gid=10001 rustfs/rustfs:1.0.4
TEST_S3_ENDPOINT=http://127.0.0.1:19000 TEST_S3_ACCESS_KEY=testkey TEST_S3_SECRET_KEY=testsecret12345 \
  npx vitest run --project=server src/lib/server/blobs        # the contract and migration specs
CHAT_BLOB_STORE=s3 CHAT_S3_ENDPOINT=http://127.0.0.1:19000 CHAT_S3_BUCKET=cerea-test \
  CHAT_S3_ACCESS_KEY_ID=testkey CHAT_S3_SECRET_ACCESS_KEY=testsecret12345 CHAT_S3_CREATE_BUCKET=true \
  npx vitest run --project=server <any other spec>             # the same specs on S3
```
