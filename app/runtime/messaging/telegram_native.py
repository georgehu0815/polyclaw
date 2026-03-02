"""Native Telegram long-polling channel — no Azure Bot Framework required.

Activates automatically when a Telegram token is configured but Azure Bot
Service is not (``infra_store.bot_configured`` is False).  Talks directly to
the Telegram Bot API: polls ``getUpdates`` and sends replies via
``sendMessage``.  No public URL or Cloudflare tunnel needed.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

import aiohttp

from ..config.settings import cfg
from ..state.memory import get_memory
from .commands import CommandDispatcher
from .formatting import strip_markdown
from .message_processor import split_message

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..agent.hitl import HitlInterceptor
    from ..state.session_store import SessionStore

logger = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
_POLL_TIMEOUT = 30          # seconds Telegram holds the long-poll connection
_HTTP_TIMEOUT = 40          # total aiohttp timeout (server timeout + buffer)
_SEND_TIMEOUT = 10          # timeout for outbound sendMessage calls
_RETRY_SLEEP = 5            # seconds to wait after a polling error


class TelegramPollingChannel:
    """Receives and sends Telegram messages via the native Bot API."""

    def __init__(
        self,
        *,
        token: str,
        agent: Agent,
        hitl: HitlInterceptor | None,
        session_store: SessionStore,
    ) -> None:
        self._token = token
        self._agent = agent
        self._hitl = hitl
        self._session_store = session_store
        self._memory = get_memory()
        self._commands = CommandDispatcher(agent, session_store)
        self._lock = asyncio.Lock()
        self._http: aiohttp.ClientSession | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> asyncio.Task:
        """Open the HTTP session and start the polling loop.

        Returns the background Task so the caller can store and cancel it.
        """
        self._http = aiohttp.ClientSession()
        task = asyncio.create_task(self._poll_loop(), name="telegram_poll")
        logger.info("[telegram] polling started")
        return task

    async def stop(self) -> None:
        """Close the HTTP session (call after the polling Task is cancelled)."""
        if self._http and not self._http.closed:
            await self._http.close()
        logger.info("[telegram] polling stopped")

    # ------------------------------------------------------------------
    # Polling loop
    # ------------------------------------------------------------------

    async def _poll_loop(self) -> None:
        offset = 0
        while True:
            try:
                updates = await self._get_updates(offset)
                for update in updates:
                    offset = update["update_id"] + 1
                    asyncio.create_task(self._handle_update(update))
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.error("[telegram] polling error: %s", exc, exc_info=True)
                await asyncio.sleep(_RETRY_SLEEP)

    async def _get_updates(self, offset: int) -> list:
        assert self._http is not None
        url = _TELEGRAM_API.format(token=self._token, method="getUpdates")
        async with self._http.get(
            url,
            params={"timeout": _POLL_TIMEOUT, "offset": offset},
            timeout=aiohttp.ClientTimeout(total=_HTTP_TIMEOUT),
        ) as resp:
            data = await resp.json()
            return data.get("result", []) if data.get("ok") else []

    # ------------------------------------------------------------------
    # Inbound message routing
    # ------------------------------------------------------------------

    async def _handle_update(self, update: dict) -> None:
        msg = update.get("message") or update.get("edited_message")
        if not msg:
            return

        chat_id: int = msg["chat"]["id"]
        from_id: str = str(msg.get("from", {}).get("id", ""))
        text: str = (msg.get("text") or "").strip()

        if not text:
            return

        # Whitelist check
        whitelist = cfg.telegram_whitelist
        if whitelist and from_id not in whitelist:
            logger.warning("[telegram] blocked user %s (not in whitelist)", from_id)
            return

        # If the agent is waiting for HITL approval, resolve with this reply
        if self._hitl and self._hitl.has_pending_approval:
            if self._hitl.resolve_bot_reply(text):
                logger.info("[telegram] resolved HITL approval via chat_id=%s", chat_id)
                return

        # Slash commands (/new, /status, /skills, …)
        async def reply_fn(t: str) -> None:
            await self._send(chat_id, t)

        if await self._commands.try_handle(text, reply_fn, "telegram"):
            return

        # Regular agent turn
        asyncio.create_task(self._run_turn(chat_id, text))

    # ------------------------------------------------------------------
    # Agent turn
    # ------------------------------------------------------------------

    async def _run_turn(self, chat_id: int, text: str) -> None:
        asyncio.create_task(self._send_typing(chat_id))

        async with self._lock:
            # Auto-create a session if none is active
            if not self._session_store.current_session_id:
                auto_id = str(uuid.uuid4())
                logger.info("[telegram] auto-creating session %s", auto_id)
                self._session_store.start_session(auto_id, model=cfg.copilot_model)

            self._memory.record("user", text)
            self._session_store.record("user", text, channel="telegram")

            async def bot_reply(msg: str) -> None:
                for chunk in split_message(strip_markdown(msg)):
                    await self._send(chat_id, chunk)

            if self._hitl:
                self._hitl.bind_turn(
                    bot_reply_fn=bot_reply,
                    execution_context="telegram_poller",
                    model=cfg.copilot_model,
                )
            try:
                response = await self._agent.send(text)
            except Exception as exc:
                logger.error("[telegram] agent error: %s", exc, exc_info=True)
                response = None
            finally:
                if self._hitl:
                    self._hitl.unbind_turn()

            if response:
                self._memory.record("assistant", response)
                self._session_store.record("assistant", response, channel="telegram")
                for chunk in split_message(strip_markdown(response)):
                    await self._send(chat_id, chunk)
            else:
                await self._send(chat_id, "An error occurred while processing your message.")

    # ------------------------------------------------------------------
    # Telegram API helpers
    # ------------------------------------------------------------------

    async def _send(self, chat_id: int, text: str) -> None:
        assert self._http is not None
        url = _TELEGRAM_API.format(token=self._token, method="sendMessage")
        try:
            async with self._http.post(
                url,
                json={"chat_id": chat_id, "text": text},
                timeout=aiohttp.ClientTimeout(total=_SEND_TIMEOUT),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.error("[telegram] sendMessage failed %s: %s", resp.status, body[:200])
        except Exception as exc:
            logger.error("[telegram] sendMessage error: %s", exc)

    async def _send_typing(self, chat_id: int) -> None:
        assert self._http is not None
        url = _TELEGRAM_API.format(token=self._token, method="sendChatAction")
        try:
            async with self._http.post(
                url,
                json={"chat_id": chat_id, "action": "typing"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as _:
                pass
        except Exception:
            pass
