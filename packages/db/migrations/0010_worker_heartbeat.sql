-- 0010_worker_heartbeat
-- Liveness marker written by the worker; no company data, no RLS.

CREATE TABLE worker_heartbeat (
  id  integer PRIMARY KEY,
  at  timestamptz NOT NULL
);

SELECT app.grant_app_privileges();
