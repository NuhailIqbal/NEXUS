"""
The dialing-strategy migration (migrate._DIALING_STATEMENTS, run by migrate.bootstrap_schema).

A database from before the feature is rebuilt in a scratch database (the new columns dropped, legacy
campaigns and contacts inserted), upgraded twice and inspected: campaigns that existed become Concurrent /
20 and are not running, campaigns created afterwards are Sequential / 5 / 10 / 0, a campaign parked or
killed mid-pass becomes an open pass that is Paused, contacts are numbered in (created_at, id) order and
keep being numbered, the second run changes nothing, and the preflight reports a missing column.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg.rows import dict_row

import byot_harness as H
import migrate

UTC = timezone.utc
MIG_DB = "nexus_qa_dialmig"
T0 = datetime(2026, 1, 5, 9, 0, tzinfo=UTC)

# Everything the migration adds, so that the "before" state can be rebuilt.
UNDO = [
    "DROP TRIGGER IF EXISTS contacts_seq_list_change ON public.contacts",
    "DROP FUNCTION IF EXISTS public.contacts_seq_on_list_change()",
    "ALTER TABLE public.outbound_campaigns DROP CONSTRAINT IF EXISTS outbound_campaigns_dial_chk",
    """ALTER TABLE public.outbound_campaigns DROP COLUMN dial_strategy, DROP COLUMN dial_concurrent_calls,
         DROP COLUMN dial_calls_per_minute, DROP COLUMN dial_delay_seconds, DROP COLUMN dial_running,
         DROP COLUMN dial_seq, DROP COLUMN dial_legacy_cursor, DROP COLUMN dial_next_at,
         DROP COLUMN dial_pass_started_at, DROP COLUMN dial_batch_seq, DROP COLUMN dial_stall, DROP COLUMN dial_counters""",
    "ALTER TABLE public.contacts DROP COLUMN seq",
    "DROP SEQUENCE public.contacts_seq_seq",
    "DROP INDEX IF EXISTS public.campaign_attempts_open_idx",
    "DROP INDEX IF EXISTS public.campaign_attempts_placed_idx",
    "DROP INDEX IF EXISTS public.campaign_attempts_ended_idx",
    "DROP INDEX IF EXISTS public.campaign_attempts_camp_key_idx",
    "ALTER TABLE public.campaign_attempts DROP COLUMN dial_strategy, DROP COLUMN dial_slot, DROP COLUMN dial_batch, DROP COLUMN dial_source",
    "ALTER TABLE public.billing DROP COLUMN max_concurrent_calls",
    """ALTER TABLE public.platform_settings DROP COLUMN dial_account_default, DROP COLUMN dial_platform_max,
         DROP COLUMN dial_learned_cap, DROP COLUMN dial_learned_until""",
]


class MigrationBase(unittest.TestCase):
    def setUp(self):
        self.mig_url = urlunparse(urlparse(H.h.QA_URL)._replace(path=f"/{MIG_DB}"))
        with psycopg.connect(H.h.ADMIN_URL, autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {MIG_DB} WITH (FORCE)")
            c.execute(f"CREATE DATABASE {MIG_DB}")
        p = patch.object(migrate, "settings", SimpleNamespace(database_url=self.mig_url))
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.drop_db)
        migrate.bootstrap_schema()

    def drop_db(self):
        with psycopg.connect(H.h.ADMIN_URL, autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {MIG_DB} WITH (FORCE)")

    def conn(self):
        return psycopg.connect(self.mig_url, autocommit=True)

    def downgrade(self):
        """Put the database back to how it was before the feature."""
        with self.conn() as c:
            for stmt in UNDO:
                c.execute(stmt)

    def upgrade(self):
        migrate.bootstrap_schema()

    def one(self, sql, params=()):
        with self.conn() as c:
            return c.execute(sql, params).fetchone()

    def all(self, sql, params=()):
        with self.conn() as c:
            return c.execute(sql, params).fetchall()


class LegacyUpgradeTests(MigrationBase):
    def setUp(self):
        super().setUp()
        self.downgrade()
        with self.conn() as c:
            self.user = c.execute("INSERT INTO users(email) VALUES ('mig@qa.test') RETURNING id").fetchone()[0]
            self.list = c.execute("INSERT INTO lists(user_id, name) VALUES (%s, 'L') RETURNING id", (self.user,)).fetchone()[0]
            # contacts inserted out of order: created_at decides, then id. Two share a created_at.
            ids = [uuid.UUID(f"00000000-0000-0000-0000-00000000000{i}") for i in range(1, 6)]
            self.ids = ids
            plan = [(ids[0], T0 + timedelta(minutes=30)), (ids[1], T0 + timedelta(minutes=10)), (ids[2], T0 + timedelta(minutes=20)),
                    (ids[4], T0 + timedelta(minutes=10)), (ids[3], T0)]
            for cid, at in plan:
                c.execute("INSERT INTO contacts(id, user_id, name, phone, list_id, created_at) VALUES (%s, %s, %s, %s, %s, %s)",
                          (cid, self.user, f"n{cid.int}", f"+1555000{cid.int:04d}", self.list, at))
            self.idle = self.campaign(c, "idle", "Inactive")
            self.parked = self.campaign(c, "parked", "Paused", cursor=ids[2], stopped_by_hours=True)
            self.stale = self.campaign(c, "stale", "Active", cursor=ids[1], lease=True)
            self.finished = self.campaign(c, "finished", "Active")      # Active with nothing open: a finished campaign

    def campaign(self, c, name, status, cursor=None, stopped_by_hours=False, lease=False):
        return c.execute(
            "INSERT INTO outbound_campaigns(user_id, name, status, list_id, dial_cursor, stopped_by_hours_at, run_token, run_heartbeat_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (self.user, name, status, self.list, cursor, T0 if stopped_by_hours else None,
             uuid.uuid4() if lease else None, T0 - timedelta(hours=1) if lease else None)).fetchone()[0]

    def camp(self, cid):
        with psycopg.connect(self.mig_url, autocommit=True, row_factory=dict_row) as c:
            return c.execute("SELECT * FROM outbound_campaigns WHERE id = %s", (cid,)).fetchone()

    def test_the_before_state_really_has_none_of_the_new_columns(self):
        with self.conn() as c:
            self.assertEqual(len(migrate.missing_dialing_columns(c)), len(migrate.DIALING_COLUMNS))

    def test_legacy_campaigns_become_concurrent_20(self):
        self.upgrade()
        for cid in (self.idle, self.parked, self.stale, self.finished):
            row = self.camp(cid)
            self.assertEqual((row["dial_strategy"], row["dial_concurrent_calls"], row["dial_calls_per_minute"], row["dial_delay_seconds"]),
                             ("concurrent", 20, 10, 0), row["name"])

    def test_a_campaign_created_after_the_upgrade_is_sequential_5_10_0(self):
        self.upgrade()
        with self.conn() as c:
            cid = c.execute("INSERT INTO outbound_campaigns(user_id, name) VALUES (%s, 'new') RETURNING id", (self.user,)).fetchone()[0]
        row = self.camp(cid)
        self.assertEqual((row["dial_strategy"], row["dial_concurrent_calls"], row["dial_calls_per_minute"], row["dial_delay_seconds"]),
                         ("sequential", 5, 10, 0))
        self.assertEqual((row["dial_running"], row["dial_seq"], row["dial_next_at"], row["dial_stall"], row["dial_counters"], row["dial_batch_seq"]),
                         (False, None, None, None, {}, 0))

    def test_idle_and_finished_campaigns_are_not_running_and_keep_their_status(self):
        self.upgrade()
        for cid, status in ((self.idle, "Inactive"), (self.finished, "Active")):
            row = self.camp(cid)
            self.assertEqual((row["dial_running"], row["status"], row["dial_legacy_cursor"], row["dial_pass_started_at"]),
                             (False, status, None, None))

    def test_a_campaign_parked_by_the_hours_mid_pass_becomes_an_open_paused_pass(self):
        self.upgrade()
        row = self.camp(self.parked)
        self.assertEqual((row["dial_running"], row["status"], row["dial_legacy_cursor"], row["dial_cursor"], row["dial_seq"]),
                         (True, "Paused", self.ids[2], self.ids[2], None))
        self.assertIsNotNone(row["dial_pass_started_at"])
        self.assertEqual(row["stopped_by_hours_at"], T0, "the marker is kept, so the automatic continuing still applies")

    def test_an_active_campaign_killed_mid_run_is_parked_and_its_lease_dropped(self):
        self.upgrade()
        row = self.camp(self.stale)
        self.assertEqual((row["status"], row["dial_running"], row["run_token"], row["run_heartbeat_at"], row["dial_legacy_cursor"]),
                         ("Paused", True, None, None, self.ids[1]))

    def test_contacts_are_numbered_in_created_at_then_id_order(self):
        self.upgrade()
        rows = self.all("SELECT id, seq FROM contacts ORDER BY seq")
        # oldest first: ids[3] (T0), then the two at T0+10 min ordered by id (ids[1], ids[4]), ids[2], ids[0]
        self.assertEqual([r[0] for r in rows], [self.ids[3], self.ids[1], self.ids[4], self.ids[2], self.ids[0]])
        self.assertEqual([r[1] for r in rows], [1, 2, 3, 4, 5])

    def test_contacts_created_later_get_higher_numbers_and_a_move_to_another_list_renumbers(self):
        self.upgrade()
        with self.conn() as c:
            other = c.execute("INSERT INTO lists(user_id, name) VALUES (%s, 'L2') RETURNING id", (self.user,)).fetchone()[0]
            new = c.execute("INSERT INTO contacts(user_id, name, phone, list_id) VALUES (%s, 'late', '+15550009999', %s) RETURNING id, seq",
                            (self.user, self.list)).fetchone()
            self.assertEqual(new[1], 6)
            before = c.execute("SELECT seq FROM contacts WHERE id = %s", (self.ids[3],)).fetchone()[0]
            c.execute("UPDATE contacts SET name = 'renamed' WHERE id = %s", (self.ids[3],))
            self.assertEqual(c.execute("SELECT seq FROM contacts WHERE id = %s", (self.ids[3],)).fetchone()[0], before, "a rename keeps the place")
            c.execute("UPDATE contacts SET list_id = %s WHERE id = %s", (self.list, self.ids[3]))
            self.assertEqual(c.execute("SELECT seq FROM contacts WHERE id = %s", (self.ids[3],)).fetchone()[0], before, "same list: same place")
            c.execute("UPDATE contacts SET list_id = %s WHERE id = %s", (other, self.ids[3]))
            moved = c.execute("SELECT seq FROM contacts WHERE id = %s", (self.ids[3],)).fetchone()[0]
            self.assertGreater(moved, 6, "a contact moved into another list goes to the back of it")
            c.execute("UPDATE contacts SET list_id = NULL WHERE id = %s", (self.ids[3],))
            self.assertGreater(c.execute("SELECT seq FROM contacts WHERE id = %s", (self.ids[3],)).fetchone()[0], moved)

    def test_every_contact_has_a_number_and_the_column_is_not_null(self):
        self.upgrade()
        self.assertEqual(self.one("SELECT count(*) FROM contacts WHERE seq IS NULL")[0], 0)
        self.assertEqual(self.one("SELECT is_nullable FROM information_schema.columns WHERE table_name='contacts' AND column_name='seq'")[0], "NO")
        with self.conn() as c, self.assertRaises(psycopg.errors.NotNullViolation):
            c.execute("INSERT INTO contacts(user_id, name, seq) VALUES (%s, 'x', NULL)", (self.user,))

    def test_the_upgrade_is_additive_nothing_is_lost(self):
        self.upgrade()
        self.assertEqual(self.one("SELECT count(*) FROM contacts")[0], 5)
        self.assertEqual(self.one("SELECT count(*) FROM outbound_campaigns")[0], 4)

    def test_the_second_and_third_runs_change_nothing(self):
        self.upgrade()
        snap = lambda: (self.all("SELECT id, seq FROM contacts ORDER BY id"),
                        self.all("SELECT id, status, dial_strategy, dial_concurrent_calls, dial_running, dial_seq, dial_legacy_cursor, "
                                 "dial_cursor, dial_pass_started_at, stopped_by_hours_at, run_token, run_heartbeat_at "
                                 "FROM outbound_campaigns ORDER BY id"),
                        self.one("SELECT last_value FROM contacts_seq_seq"))
        first = snap()
        self.upgrade()
        self.assertEqual(snap(), first)
        self.upgrade()
        self.assertEqual(snap(), first)

    def test_a_later_run_never_touches_a_campaign_that_changed_since(self):
        """Settings a person chose after the upgrade survive the next start."""
        self.upgrade()
        with self.conn() as c:
            c.execute("UPDATE outbound_campaigns SET dial_strategy = 'paced', dial_calls_per_minute = 30, dial_delay_seconds = 5 WHERE id = %s", (self.idle,))
        self.upgrade()
        row = self.camp(self.idle)
        self.assertEqual((row["dial_strategy"], row["dial_calls_per_minute"], row["dial_delay_seconds"]), ("paced", 30, 5))

    def test_the_sequence_never_goes_backwards_on_a_rerun(self):
        self.upgrade()
        with self.conn() as c:
            for i in range(10):
                c.execute("INSERT INTO contacts(user_id, name) VALUES (%s, %s)", (self.user, f"x{i}"))
            c.execute("DELETE FROM contacts WHERE seq > 9")        # leave the sequence ahead of the largest number
            ahead = c.execute("SELECT last_value FROM contacts_seq_seq").fetchone()[0]
        self.upgrade()
        self.assertEqual(self.one("SELECT last_value FROM contacts_seq_seq")[0], ahead)

    def test_the_numbering_works_in_small_chunks_too(self):
        # the "before" state has no seq column: add it bare (as the migration does), then number in tiny chunks
        with self.conn() as c:
            c.execute("ALTER TABLE contacts ADD COLUMN seq bigint")
            c.execute("INSERT INTO contacts(user_id, name, created_at, seq) SELECT %s, 'bulk', %s + (g || ' seconds')::interval, 100 + g "
                      "FROM generate_series(1, 3) g", (self.user, T0 + timedelta(days=1)))
            c.execute("INSERT INTO contacts(user_id, name, created_at) SELECT %s, 'late' || g, %s + (g || ' seconds')::interval "
                      "FROM generate_series(1, 7) g", (self.user, T0 + timedelta(days=2)))
        with patch.object(migrate, "_SEQ_CHUNK", 2), self.conn() as c:
            migrate._backfill_contacts_seq(c)
            rows = c.execute("SELECT name, seq FROM contacts WHERE name LIKE 'late%' ORDER BY seq").fetchall()
        self.assertEqual([r[0] for r in rows], [f"late{i}" for i in range(1, 8)], "oldest first across chunks")
        seqs = [r[1] for r in rows]
        self.assertEqual(seqs, list(range(seqs[0], seqs[0] + 7)), "consecutive")
        self.assertGreater(seqs[0], 103, "continues after the largest number already used")


class FreshDatabaseTests(MigrationBase):
    def test_a_fresh_database_has_everything_and_new_campaigns_are_sequential(self):
        with self.conn() as c:
            self.assertEqual(migrate.missing_dialing_columns(c), [])
            self.assertTrue(migrate.dialing_ready(c))
            u = c.execute("INSERT INTO users(email) VALUES ('f@qa.test') RETURNING id").fetchone()[0]
            cid = c.execute("INSERT INTO outbound_campaigns(user_id, name) VALUES (%s, 'n') RETURNING id", (u,)).fetchone()[0]
            row = c.execute("SELECT dial_strategy, dial_concurrent_calls, dial_calls_per_minute, dial_delay_seconds FROM outbound_campaigns WHERE id = %s", (cid,)).fetchone()
        self.assertEqual(row, ("sequential", 5, 10, 0))

    def test_the_constraint_and_the_indexes_exist(self):
        names = {r[0] for r in self.all("SELECT indexname FROM pg_indexes WHERE schemaname='public'")}
        for idx in ("campaign_attempts_slot_idx", "campaign_attempts_open_idx", "campaign_attempts_placed_idx",
                    "campaign_attempts_ended_idx", "campaign_attempts_camp_key_idx", "contacts_list_seq_idx",
                    "campaign_attempts_one_open_call_idx"):
            self.assertIn(idx, names)
        self.assertEqual(self.one("SELECT count(*) FROM pg_constraint WHERE conname = 'outbound_campaigns_dial_chk'")[0], 1)
        self.assertEqual(self.one("SELECT count(*) FROM pg_trigger WHERE tgname = 'contacts_seq_list_change'")[0], 1)

    def test_the_check_constraint_refuses_bad_settings(self):
        with self.conn() as c:
            u = c.execute("INSERT INTO users(email) VALUES ('c@qa.test') RETURNING id").fetchone()[0]
            for col, val in (("dial_strategy", "'parallel'"), ("dial_concurrent_calls", "0"), ("dial_concurrent_calls", "21"),
                             ("dial_calls_per_minute", "0"), ("dial_calls_per_minute", "61"), ("dial_delay_seconds", "-1"),
                             ("dial_delay_seconds", "61")):
                with self.subTest(col=col, val=val), self.assertRaises(psycopg.errors.CheckViolation):
                    c.execute(f"INSERT INTO outbound_campaigns(user_id, name, {col}) VALUES (%s, 'bad', {val})", (u,))

    def test_the_slot_index_allows_one_open_call_per_slot_and_reports_its_name(self):
        with self.conn() as c:
            u = c.execute("INSERT INTO users(email) VALUES ('s@qa.test') RETURNING id").fetchone()[0]
            camp = c.execute("INSERT INTO outbound_campaigns(user_id, name) VALUES (%s, 'n') RETURNING id", (u,)).fetchone()[0]
            lead = c.execute("INSERT INTO contacts(user_id, name) VALUES (%s, 'c') RETURNING id", (u,)).fetchone()[0]
            lead = c.execute("INSERT INTO campaign_leads(campaign_id, user_id, contact_id, phone) VALUES (%s, %s, %s, '+1') RETURNING id",
                             (camp, u, lead)).fetchone()[0]

            def attempt(key, slot, ended=False):
                return c.execute("INSERT INTO campaign_attempts(lead_id, campaign_id, user_id, phone_key, attempt_number, dial_slot, ended_at) "
                                 "VALUES (%s, %s, %s, %s, 1, %s, %s)", (lead, camp, u, key, slot, T0 if ended else None))
            attempt("k1", 1)
            with self.assertRaises(psycopg.errors.UniqueViolation) as cm:
                attempt("k2", 1)
            self.assertEqual(cm.exception.diag.constraint_name, "campaign_attempts_slot_idx")
            attempt("k3", 2)                       # another slot
            attempt("k4", None)                    # no slot: the index does not apply
            attempt("k5", None)
            attempt("k6", 1, ended=True)           # a closed call frees its slot
            with self.assertRaises(psycopg.errors.UniqueViolation) as cm:
                attempt("k1", 3)                   # the same number open twice
            self.assertEqual(cm.exception.diag.constraint_name, "campaign_attempts_one_open_call_idx")


class PreflightTests(MigrationBase):
    def test_nothing_missing_on_an_upgraded_database(self):
        with self.conn() as c:
            self.assertEqual(migrate.missing_dialing_columns(c), [])
            self.assertTrue(migrate.dialing_ready(c))

    def test_every_missing_column_is_named(self):
        with self.conn() as c:
            c.execute("ALTER TABLE contacts DROP COLUMN seq")
            c.execute("ALTER TABLE billing DROP COLUMN max_concurrent_calls")
            c.execute("ALTER TABLE campaign_attempts DROP COLUMN dial_slot")
            self.assertEqual(sorted(migrate.missing_dialing_columns(c)),
                             ["billing.max_concurrent_calls", "campaign_attempts.dial_slot", "contacts.seq"])
            self.assertFalse(migrate.dialing_ready(c))

    def test_a_broken_catalogue_read_is_not_ready_and_does_not_raise(self):
        class Boom:
            def execute(self, *a, **kw):
                raise RuntimeError("no")
        with self.assertLogs(migrate.logger, "WARNING"):
            self.assertFalse(migrate.dialing_ready(Boom()))

    def test_the_app_pool_form_checks_the_database_the_app_uses(self):
        # without a connection the helper reads through the app's pool: the QA database, which is fully migrated
        self.assertEqual(migrate.missing_dialing_columns(), [])
        self.assertTrue(migrate.dialing_ready())

    def test_the_list_of_columns_matches_what_the_migration_adds(self):
        # every column named in DIALING_COLUMNS is added by _DIALING_STATEMENTS (checked by the fresh database
        # having them all), and the list has no duplicates
        self.assertEqual(len(migrate.DIALING_COLUMNS), len(set(migrate.DIALING_COLUMNS)))
        self.assertEqual(len(migrate.DIALING_COLUMNS), 12 + 1 + 4 + 1 + 4)


if __name__ == "__main__":
    unittest.main()
