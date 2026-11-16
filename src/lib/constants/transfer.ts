/** File browser transfers (PROTOCOL.md §9.3). Shared by the browser and the server. */
const MiB = 1024 * 1024;

/** One uploaded file, chunked end to end (files.upload.*). */
export const UPLOAD_MAX_FILE_BYTES = 200 * MiB;
/** What the browser sends per request: well under BODY_SIZE_LIMIT. */
export const UPLOAD_CHUNK_BYTES = 8 * MiB;
/** The most one chunk request may carry (the route refuses more). */
export const UPLOAD_MAX_CHUNK_BYTES = 16 * MiB;
/** One drop or pick of a folder: its files and their total size. */
export const UPLOAD_MAX_BATCH_FILES = 5000;
export const UPLOAD_MAX_BATCH_BYTES = 2 * 1024 * MiB;
/** One downloaded file (files.download, streamed in 1 MiB chunks). */
export const DOWNLOAD_MAX_FILE_BYTES = 500 * MiB;
/** A downloaded folder (files.zip.*): uncompressed bytes and file count. */
export const ZIP_MAX_BYTES = 2 * 1024 * MiB;
export const ZIP_MAX_FILES = 20000;
