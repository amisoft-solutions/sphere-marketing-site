-- A new demo request does not ask for consent. Store that as NULL.
-- SQLite cannot remove NOT NULL without rebuilding the table.
-- Existing 0 and 1 values are copied unchanged. No column is dropped.

CREATE TABLE demo_requests_consent (
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
  consent_to_contact INTEGER CHECK (consent_to_contact IN (0, 1)),
  user_agent TEXT NOT NULL DEFAULT '',
  approval_email_sent_at TEXT,
  approval_email_claimed_at TEXT,
  approval_email_error TEXT,
  video_link_expires_at TEXT
);

INSERT INTO demo_requests_consent (
  id, created_at, updated_at, status, request_type, full_name, job_title,
  organization, work_email, phone, country, organization_type, interest, heard_about,
  consent_to_contact, user_agent, approval_email_sent_at, approval_email_claimed_at,
  approval_email_error, video_link_expires_at
)
SELECT
  id, created_at, updated_at, status, request_type, full_name, job_title,
  organization, work_email, phone, country, organization_type, interest, heard_about,
  consent_to_contact, user_agent, approval_email_sent_at, approval_email_claimed_at,
  approval_email_error, video_link_expires_at
FROM demo_requests;

DROP TABLE demo_requests;

ALTER TABLE demo_requests_consent RENAME TO demo_requests;

CREATE INDEX idx_demo_requests_status_created
  ON demo_requests (status, created_at DESC);
