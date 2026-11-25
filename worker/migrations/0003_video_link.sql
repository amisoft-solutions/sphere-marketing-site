-- Expiry of the current per-person video link. Apply with the other migrations:
--   npx wrangler d1 migrations apply sphere-demo-requests --remote

ALTER TABLE demo_requests ADD COLUMN video_link_expires_at TEXT;
