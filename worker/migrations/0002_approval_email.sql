-- Approval email bookkeeping. Apply with the other migrations:
--   npx wrangler d1 migrations apply sphere-demo-requests --remote

ALTER TABLE demo_requests ADD COLUMN approval_email_sent_at TEXT;
ALTER TABLE demo_requests ADD COLUMN approval_email_claimed_at TEXT;
ALTER TABLE demo_requests ADD COLUMN approval_email_error TEXT;
