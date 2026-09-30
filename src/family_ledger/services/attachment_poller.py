from __future__ import annotations

import logging
from threading import Event, Thread

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from family_ledger.config import Settings
from family_ledger.db import SessionLocal
from family_ledger.db import lock_engine as default_lock_engine
from family_ledger.services import attachments

logger = logging.getLogger(__name__)

# Arbitrary fixed key identifying this poller's leader-election lock -
# only meaningful in that it must stay the same across every worker
# process and every restart, and not collide with some other advisory
# lock on this database (nothing else in this codebase uses one).
_LEADER_LOCK_KEY = 4_812_573_901


def _try_become_leader(engine: Engine) -> Connection | None:
    """Session-scoped Postgres advisory lock: with several uvicorn worker
    processes (each running its own copy of this poller), whichever one
    acquires this lock is the only one that actually polls - otherwise N
    workers would N-times-over race to claim the same pending attachments
    and call out to Paperless. The lock is tied to this connection's
    lifetime, so if the leader worker crashes or is restarted, Postgres
    releases it automatically and another worker's poller picks it up on
    its next attempt - no coordinator process needed. On any non-Postgres
    dialect (the in-memory SQLite the test suite uses) there's only ever
    one worker in practice, so this trivially succeeds without touching
    the DB - mirrors db.py's read_only_transaction dialect check."""
    conn = engine.connect()
    if conn.dialect.name != "postgresql":
        return conn
    acquired = conn.execute(
        text("SELECT pg_try_advisory_lock(:key)"), {"key": _LEADER_LOCK_KEY}
    ).scalar()
    # Postgres session-level advisory locks (the plain pg_try_advisory_lock
    # form, as opposed to the _xact_ variant) aren't tied to the enclosing
    # transaction at all - only pg_advisory_unlock or the session ending
    # releases one. Committing here just ends the transaction SQLAlchemy
    # 2.0 auto-begins on first execute(); without it this connection would
    # sit idle-in-transaction for as long as this worker stays leader,
    # which many Postgres deployments forcibly kill via
    # idle_in_transaction_session_timeout - silently dropping the lock
    # without this process noticing and letting a second worker also
    # become leader.
    conn.commit()
    if not acquired:
        conn.close()
        return None
    return conn


def _release_leader(conn: Connection) -> None:
    if conn.dialect.name == "postgresql":
        conn.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _LEADER_LOCK_KEY})
    conn.close()


def _poll_cycle(
    engine: Engine, lock_conn: Connection | None, settings: Settings
) -> Connection | None:
    """One poll cycle, given whatever leader-lock connection (if any) the
    previous cycle ended with. Returns the connection to carry into the
    next cycle - None if this worker isn't (and doesn't become) the
    leader, in which case nothing here processes anything."""
    if lock_conn is None:
        lock_conn = _try_become_leader(engine)
        if lock_conn is None:
            return None
    try:
        with SessionLocal() as session:
            attachments.process_pending_attachments(session, settings)
    except Exception:
        # Anything here - a ServiceError, or an unexpected raw DB error
        # (process_pending_attachments' own session.commit() isn't wrapped
        # in commit_or_raise, so e.g. a transient OperationalError is
        # possible) - must not escape this cycle: this thread's caller
        # (_poll_forever) has no try/except of its own, so an uncaught
        # exception here would kill the poller thread mid-loop without
        # ever reaching _release_leader, permanently orphaning the
        # advisory lock (and this worker's leadership) until the whole
        # process restarts.
        logger.exception("Attachment poller cycle failed")
    return lock_conn


def _poll_forever(stop_event: Event, settings: Settings) -> None:
    lock_conn: Connection | None = None
    while not stop_event.is_set():
        lock_conn = _poll_cycle(default_lock_engine, lock_conn, settings)
        stop_event.wait(settings.paperless_poll_interval_seconds)
    if lock_conn is not None:
        _release_leader(lock_conn)


def start_attachment_poller(settings: Settings) -> tuple[Event, Thread] | None:
    if not settings.attachment_poller_enabled or not settings.paperless_is_configured():
        return None
    stop_event = Event()
    thread = Thread(
        target=_poll_forever,
        args=(stop_event, settings),
        name="attachment-poller",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def stop_attachment_poller(stop_event: Event, thread: Thread) -> None:
    stop_event.set()
    thread.join(timeout=1)
