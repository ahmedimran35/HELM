-- Migration 0003 — files now reference a blob_id (real bytes in
-- file_blobs) instead of a filesystem path. We keep the legacy `path`
-- column nullable so old rows continue to load.

ALTER TABLE files ALTER COLUMN path DROP NOT NULL;