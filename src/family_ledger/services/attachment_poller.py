from __future__ import annotations

import logging
from threading import Event, Thread

from family_ledger.config import Settings
from family_ledger.db import SessionLocal
from family_ledger.services import attachments
from family_ledger.services.errors import ServiceError

logger = logging.getLogger(__name__)


def _poll_forever(stop_event: Event, settings: Settings) -> None:
    while not stop_event.is_set():
        try:
            with SessionLocal() as session:
                attachments.process_pending_attachments(session, settings)
        except ServiceError:
            logger.exception("Attachment poller cycle failed")
        stop_event.wait(settings.paperless_poll_interval_seconds)


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
