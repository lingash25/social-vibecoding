-- A change the hold rules could not read in full is no longer held for an
-- admin: the admins are told, and it goes live on its votes and checks
-- (services/release-holds.js, the `unread` rule). Such a change has a row
-- with a fourth status, which no gate reads:
--
--   notice    the admins are told about the change; nobody's yes is owed
--
-- One per change, like a waiting hold.
ALTER TABLE release_holds DROP CONSTRAINT IF EXISTS release_holds_status_check;
ALTER TABLE release_holds ADD CONSTRAINT release_holds_status_check
  CHECK (status IN ('waiting', 'declined', 'fixed', 'notice'));

CREATE UNIQUE INDEX IF NOT EXISTS release_holds_one_notice
  ON release_holds (session_id) WHERE status = 'notice';

-- The holds waiting today for that reason alone stop waiting. Their admins
-- were already told (or will be, by the clock, in the new words), and a
-- change whose checks have settled is not read again, so nothing else would
-- release it.
UPDATE release_holds SET status = 'notice'
 WHERE status = 'waiting' AND rules = ARRAY['unread']::text[];
