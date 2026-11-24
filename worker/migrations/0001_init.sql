-- SPHERE demo requests. Apply with:
--   npx wrangler d1 migrations apply sphere-demo-requests --remote

CREATE TABLE demo_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  request_type TEXT NOT NULL,
  full_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  organization TEXT NOT NULL,
  work_email TEXT NOT NULL,
  phone TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  organization_type TEXT NOT NULL DEFAULT '',
  interest TEXT NOT NULL DEFAULT '',
  heard_about TEXT NOT NULL DEFAULT '',
  consent_to_contact INTEGER NOT NULL DEFAULT 0 CHECK (consent_to_contact IN (0, 1)),
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_demo_requests_status_created
  ON demo_requests (status, created_at DESC);

CREATE TABLE rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
