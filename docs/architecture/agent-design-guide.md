# Agent Design Guide — GitHub Copilot SDK

This guide covers every layer for building an agent on top of GitHub Copilot SDK with
agency-CLI or token-based authentication, tool calling, and skills loading.

---

## 1. Authentication

Two mutually exclusive modes. Agency CLI takes priority.

```python
from copilot import CopilotClient

class CopilotAuth:
    """
    Resolves authentication configuration for CopilotClient.

    Priority:
      1. Agency CLI  – local binary that manages token refresh automatically.
      2. GitHub Token – explicit PAT / GITHUB_TOKEN env var.
      3. gh session  – fallback (works locally, fails in containers).
    """

    def __init__(
        self,
        *,
        agency_cli_path: str | None = None,   # e.g. ~/.config/agency/CurrentVersion/agency
        github_token: str | None = None,
    ) -> None:
        self._agency_cli_path = agency_cli_path
        self._github_token = github_token

    def build_client_opts(self) -> dict:
        """Return kwargs for CopilotClient constructor."""
        opts: dict = {"log_level": "error"}

        if self._agency_cli_path and os.path.isfile(self._agency_cli_path):
            # Agency CLI sub-command is always "copilot"
            opts["cli_path"] = self._agency_cli_path
            opts["cli_args"] = ["copilot"]

        elif self._github_token:
            opts["github_token"] = self._github_token

        # else: no-op → CopilotClient falls back to the active `gh` session

        return opts
```

**Rules:**
- Agency CLI path comes from config (e.g. `~/.config/agency/CurrentVersion/agency`).
- `cli_args=["copilot"]` is mandatory when using agency CLI — it selects the copilot
  sub-command of the agency binary.
- Token auth uses `github_token=` in client opts, never as an env var injection.

---

## 2. Client Lifecycle

```python
import asyncio
from copilot import CopilotClient

MAX_START_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0   # seconds

class ManagedCopilotClient:
    """
    Wraps CopilotClient with startup retries and graceful shutdown.

    Responsibilities:
      - Start / stop the underlying Node.js process.
      - Verify authentication after startup.
      - Expose auth status for monitoring.
    """

    def __init__(self, auth: CopilotAuth) -> None:
        self._auth = auth
        self._client: CopilotClient | None = None
        self.authenticated: bool = False

    # ------------------------------------------------------------------ start
    async def start(self) -> None:
        opts = self._auth.build_client_opts()

        for attempt in range(1, MAX_START_RETRIES + 1):
            try:
                self._client = CopilotClient(opts)
                await self._client.start()
                break
            except TimeoutError as exc:
                if attempt == MAX_START_RETRIES:
                    raise RuntimeError("Copilot client failed to start") from exc
                await asyncio.sleep(RETRY_BACKOFF_BASE ** attempt)

        await self._verify_auth()

    # ------------------------------------------------------------------ stop
    async def stop(self) -> None:
        if self._client:
            try:
                await self._client.stop()
            except Exception:
                pass
            finally:
                self._client = None
                self.authenticated = False

    # ----------------------------------------------------------- verify auth
    async def _verify_auth(self) -> None:
        if not self._client:
            return
        try:
            status = await self._client.get_auth_status()
            self.authenticated = status.isAuthenticated
        except Exception:
            self.authenticated = True   # optimistic — older CLI versions lack this API

    # ----------------------------------------------------------------- guard
    @property
    def client(self) -> CopilotClient:
        if not self._client:
            raise RuntimeError("Client not started — call start() first")
        return self._client
```

---

## 3. Tool Definition

Every tool is a plain function decorated with `@define_tool`.
Parameters are always a single Pydantic model.

```python
from copilot import define_tool
from pydantic import BaseModel, Field

# ── parameter schema ────────────────────────────────────────────────────────

class SearchParams(BaseModel):
    query: str = Field(description="Full-text search query")
    limit: int = Field(default=5, description="Maximum number of results to return")

# ── tool function ────────────────────────────────────────────────────────────

@define_tool(description="Search the knowledge base for documents matching a query.")
def search_knowledge_base(params: SearchParams) -> dict:
    """
    Return value must be JSON-serialisable.
    Raise ValueError to signal a user-facing error (SDK surfaces it gracefully).
    """
    results = _run_search(params.query, params.limit)
    return {"results": results, "total": len(results)}
```

### Tool Registry

Collect all tools in one place so session config and tests share the same list.

```python
from typing import Any
from .tools.search import search_knowledge_base
from .tools.scheduler import schedule_task, cancel_task, list_tasks
from .tools.cards import send_adaptive_card

class ToolRegistry:
    """
    Central registry of all callable tools for the agent session.

    Pattern:
      - _BASE_TOOLS  — always-on tools
      - feature-gated tools appended at build time via add()
    """

    _BASE_TOOLS: list[Any] = [
        search_knowledge_base,
        schedule_task,
        cancel_task,
        list_tasks,
        send_adaptive_card,
    ]

    def __init__(self) -> None:
        self._tools: list[Any] = list(self._BASE_TOOLS)

    def add(self, tool: Any) -> None:
        """Append a feature-gated tool (e.g., optional integrations)."""
        self._tools.append(tool)

    def remove(self, name: str) -> None:
        """Remove a tool by its registered name (e.g., for sandbox mode)."""
        self._tools = [t for t in self._tools if getattr(t, "__name__", "") != name]

    def all(self) -> list[Any]:
        return list(self._tools)


def build_tool_registry() -> ToolRegistry:
    """Factory — adds optional tools based on runtime configuration."""
    registry = ToolRegistry()

    # Example: optional memory search tool
    from .state.memory_config import get_memory_config
    mem_cfg = get_memory_config()
    if mem_cfg.enabled:
        from .tools.memory import search_memories
        registry.add(search_memories)

    return registry
```

---

## 4. Tool Hooks (Pre / Post)

Hooks intercept every tool call before and after execution.
Use them for HITL approval, sandboxing, logging, and rate-limiting.

```python
from typing import Any, Awaitable, Callable

PreToolHook  = Callable[[dict, Any], Awaitable[dict]]
PostToolHook = Callable[[dict, Any], Awaitable[None]]


# ── built-in auto-approve hook ───────────────────────────────────────────────

async def auto_approve(input_data: dict, invocation: Any) -> dict:
    """Always allow — used in non-interactive or trusted contexts."""
    return {"permissionDecision": "allow"}


# ── HITL hook base class ─────────────────────────────────────────────────────

class HitlHook:
    """
    Human-in-the-loop pre-tool hook.

    Before each tool call the hook:
      1. Emits an approval-request event to the active channel (web / bot / phone).
      2. Waits for human approval (or timeout → deny).
      3. Returns allow / deny to the SDK.

    Bind per-turn state with bind_turn() before every agent.send() call.
    """

    def __init__(self) -> None:
        self._emit: Callable | None = None
        self._reply_fn: Callable | None = None

    def bind_turn(
        self,
        *,
        emit: Callable[[str, dict], None] | None = None,
        reply_fn: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self._emit = emit
        self._reply_fn = reply_fn

    def unbind_turn(self) -> None:
        self._emit = None
        self._reply_fn = None

    async def on_pre_tool_use(self, input_data: dict, invocation: Any) -> dict:
        tool_name = input_data.get("toolName", "unknown")

        if self._emit:
            self._emit("tool_approval_request", {"tool": tool_name, "input": input_data})

        approved = await self._wait_for_approval(tool_name)
        return {"permissionDecision": "allow" if approved else "deny"}

    async def _wait_for_approval(self, tool_name: str) -> bool:
        raise NotImplementedError


# ── Hook composition ─────────────────────────────────────────────────────────

def compose_hooks(
    primary: PreToolHook,
    secondary: PreToolHook,
    post: PostToolHook | None = None,
) -> dict:
    """
    Chain two pre-tool hooks.
    secondary only runs when primary returns "allow".
    """

    async def _chained(input_data: dict, invocation: Any) -> dict:
        result = await primary(input_data, invocation)
        if result.get("permissionDecision") != "allow":
            return result
        return await secondary(input_data, invocation)

    hooks: dict = {"on_pre_tool_use": _chained}
    if post:
        hooks["on_post_tool_use"] = post
    return hooks
```

---

## 5. Skills Loading

Skills are Markdown files with YAML frontmatter consumed by the Copilot SDK.
Point `skill_directories` in session config to folders containing `SKILL.md` files.

```
skills/
  builtin/
    summarize/SKILL.md
    translate/SKILL.md
  user/
    custom-report/SKILL.md
```

**`SKILL.md` format:**

```markdown
---
name: summarize
verb: summarize
description: Condense long text into a bullet-point summary.
category: productivity
---

When asked to summarize text, produce 3–5 concise bullet points.
Focus on key decisions, actions, and outcomes.
```

```python
import os
from dataclasses import dataclass, field
from pathlib import Path

@dataclass
class SkillInfo:
    name: str
    verb: str = ""
    description: str = ""
    category: str = ""
    path: Path = field(default_factory=Path)
    installed: bool = False
    origin: str = "built-in"   # "built-in" | "user" | "marketplace"


class SkillDirectoryLoader:
    """
    Discovers and validates skill files in one or more directories.

    Usage:
        loader = SkillDirectoryLoader([builtin_dir, user_dir])
        skills = loader.list()
    """

    def __init__(self, directories: list[str | Path]) -> None:
        self._dirs = [Path(d) for d in directories]

    def list(self) -> list[SkillInfo]:
        skills: list[SkillInfo] = []
        for d in self._dirs:
            if not d.is_dir():
                continue
            for skill_dir in sorted(d.iterdir()):
                skill_file = skill_dir / "SKILL.md"
                if skill_file.is_file():
                    info = self._parse(skill_file)
                    if info:
                        skills.append(info)
        return skills

    def _parse(self, path: Path) -> SkillInfo | None:
        """Extract YAML frontmatter from SKILL.md."""
        import re, yaml
        text = path.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not m:
            return None
        meta = yaml.safe_load(m.group(1)) or {}
        return SkillInfo(
            name=meta.get("name", path.parent.name),
            verb=meta.get("verb", ""),
            description=meta.get("description", ""),
            category=meta.get("category", ""),
            path=path,
            installed=True,
        )
```

---

## 6. Session Configuration

`SessionConfig` centralises every knob passed to `client.create_session()`.

```python
from dataclasses import dataclass, field
from typing import Any

@dataclass
class SessionConfig:
    """
    Full configuration for a Copilot SDK agent session.

    Fields map 1-to-1 to the dict accepted by client.create_session().
    """

    model: str = "claude-sonnet-4.6"
    streaming: bool = True

    # ── tools & skills ───────────────────────────────────────────────────────
    tools: list[Any] = field(default_factory=list)
    skill_directories: list[str] = field(default_factory=list)
    excluded_tools: list[str] = field(default_factory=list)  # sandbox use

    # ── hooks ────────────────────────────────────────────────────────────────
    hooks: dict[str, Any] = field(default_factory=dict)
    on_permission_request: Any = None

    # ── system prompt ────────────────────────────────────────────────────────
    system_message: dict[str, str] = field(default_factory=dict)
    # e.g. {"mode": "replace", "content": "You are a helpful assistant."}
    # mode options: "replace" | "append" | "prepend"

    # ── MCP servers ──────────────────────────────────────────────────────────
    mcp_servers: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d: dict = {
            "model": self.model,
            "streaming": self.streaming,
            "tools": self.tools,
            "skill_directories": self.skill_directories,
            "hooks": self.hooks,
        }
        if self.on_permission_request:
            d["on_permission_request"] = self.on_permission_request
        if self.system_message:
            d["system_message"] = self.system_message
        if self.excluded_tools:
            d["excluded_tools"] = self.excluded_tools
        if self.mcp_servers:
            d["mcp_servers"] = self.mcp_servers
        return d
```

---

## 7. Event Handler (Streaming)

```python
import asyncio
from copilot import SessionEventType
from typing import Callable, Any

class EventHandler:
    """
    Subscribes to Copilot SDK session events.

    Lifecycle:
      1. Call session.on(handler) to register.
      2. Await handler.done to block until SESSION_IDLE or SESSION_ERROR.
      3. Read handler.final_text, handler.error, handler.tokens_used.

    Callbacks:
      on_delta(str)            – called for each streamed text chunk
      on_event(str, dict)      – called for tool/skill/subagent events
    """

    def __init__(
        self,
        on_delta: Callable[[str], None] | None = None,
        on_event: Callable[[str, dict], None] | None = None,
    ) -> None:
        self.on_delta = on_delta
        self.on_event = on_event

        self.final_text: str | None = None
        self.error: str | None = None
        self.done = asyncio.Event()
        self.input_tokens: int | None = None
        self.output_tokens: int | None = None
        self._chunks: list[str] = []

    def __call__(self, event: Any) -> None:
        etype = event.type

        if etype == SessionEventType.ASSISTANT_MESSAGE_DELTA:
            chunk = event.data.content or ""
            self._chunks.append(chunk)
            if self.on_delta:
                self.on_delta(chunk)

        elif etype == SessionEventType.ASSISTANT_MESSAGE:
            self.final_text = event.data.content
            self._extract_token_usage(event)

        elif etype == SessionEventType.SESSION_IDLE:
            if self.final_text is None:
                self.final_text = "".join(self._chunks)
            self.done.set()

        elif etype == SessionEventType.SESSION_ERROR:
            self.error = str(event.data)
            self.done.set()

        elif self.on_event:
            self._dispatch(etype, event)

    # ---------------------------------------------------------------- helpers
    def _extract_token_usage(self, event: Any) -> None:
        usage = getattr(getattr(event, "data", None), "usage", None)
        if usage:
            self.input_tokens  = getattr(usage, "inputTokens",  None)
            self.output_tokens = getattr(usage, "outputTokens", None)

    def _dispatch(self, etype: Any, event: Any) -> None:
        table = {
            SessionEventType.TOOL_EXECUTION_START:    ("tool_start",    {"tool": event.data}),
            SessionEventType.TOOL_EXECUTION_COMPLETE: ("tool_complete", {"tool": event.data}),
            SessionEventType.SKILL_INVOKED:           ("skill_invoked", {"skill": event.data}),
            SessionEventType.SUBAGENT_STARTED:        ("subagent_start",{"agent": event.data}),
            SessionEventType.SUBAGENT_COMPLETED:      ("subagent_done", {"agent": event.data}),
        }
        if etype in table:
            name, payload = table[etype]
            self.on_event(name, payload)
```

---

## 8. Agent Class (Full Integration)

```python
import asyncio
from typing import Callable, Any, Awaitable

RESPONSE_TIMEOUT = 300.0   # seconds

class Agent:
    """
    Top-level agent that owns the full lifecycle:
      auth → client → session → send → stream → teardown

    Typical usage:
        agent = Agent(auth, session_config)
        await agent.start()
        response = await agent.send("Hello!", on_delta=print)
        await agent.stop()
    """

    def __init__(
        self,
        auth: CopilotAuth,
        session_config: SessionConfig,
    ) -> None:
        self._auth = auth
        self._session_config = session_config
        self._managed = ManagedCopilotClient(auth)
        self._session: Any = None

    # ─────────────────────────────────────────────── lifecycle

    async def start(self) -> None:
        await self._managed.start()

    async def stop(self) -> None:
        await self._destroy_session()
        await self._managed.stop()

    @property
    def authenticated(self) -> bool:
        return self._managed.authenticated

    # ─────────────────────────────────────────────── session

    async def new_session(self) -> None:
        await self._destroy_session()
        self._session = await self._managed.client.create_session(
            self._session_config.to_dict()
        )

    async def _destroy_session(self) -> None:
        if self._session:
            try:
                await self._session.destroy()
            except Exception:
                pass
            finally:
                self._session = None

    # ─────────────────────────────────────────────── send

    async def send(
        self,
        prompt: str,
        *,
        on_delta: Callable[[str], None] | None = None,
        on_event: Callable[[str, dict], None] | None = None,
    ) -> str | None:
        """
        Send a prompt; stream response via on_delta; return final text.

        Creates a session automatically on first call.
        Recovers from "Session not found" by creating a new session and retrying.
        """
        if not self._managed.authenticated:
            return "Not authenticated. Please configure credentials."

        if not self._session:
            await self.new_session()

        return await self._send_inner(prompt, on_delta, on_event)

    async def _send_inner(
        self,
        prompt: str,
        on_delta: Callable[[str], None] | None,
        on_event: Callable[[str, dict], None] | None,
    ) -> str | None:
        handler = EventHandler(on_delta, on_event)
        unsub = self._session.on(handler)
        try:
            try:
                await self._session.send({"prompt": prompt})
            except Exception as exc:
                if "Session not found" in str(exc):
                    await self.new_session()
                    handler = EventHandler(on_delta, on_event)
                    unsub = self._session.on(handler)
                    await self._session.send({"prompt": prompt})
                else:
                    raise

            await asyncio.wait_for(handler.done.wait(), timeout=RESPONSE_TIMEOUT)

        except asyncio.TimeoutError:
            await self._destroy_session()   # session is stuck; discard it

        finally:
            try:
                unsub()
            except Exception:
                pass

        return handler.final_text
```

---

## 9. One-Shot (Ephemeral) Sessions

Use when you need a single LLM call outside the main conversation (background tasks,
memory formation, scheduled jobs).

```python
async def run_one_shot(
    prompt: str,
    *,
    auth: CopilotAuth,
    model: str = "claude-sonnet-4.6",
    system_message: str = "",
    tools: list[Any] | None = None,
    timeout: float = 300.0,
) -> str | None:
    """
    Spin up a temporary client, run one prompt, tear everything down.
    No session state is preserved between calls.
    """
    opts = auth.build_client_opts()
    client = CopilotClient(opts)
    await client.start()

    try:
        cfg: dict[str, Any] = {
            "model": model,
            "on_permission_request": lambda *_: {"decision": "allow"},
            "hooks": {"on_pre_tool_use": auto_approve},
        }
        if system_message:
            cfg["system_message"] = {"mode": "append", "content": system_message}
        if tools:
            cfg["tools"] = tools

        session = await client.create_session(cfg)
        handler = EventHandler()
        unsub = session.on(handler)

        try:
            await session.send({"prompt": prompt})
            await asyncio.wait_for(handler.done.wait(), timeout=timeout)
        finally:
            try:
                unsub()
                await session.destroy()
            except Exception:
                pass

        return handler.final_text

    finally:
        try:
            await client.stop()
        except Exception:
            pass
```

---

## 10. Assembly — Putting It All Together

```python
async def build_agent(
    *,
    agency_cli_path: str | None = None,
    github_token: str | None = None,
    model: str = "claude-sonnet-4.6",
    builtin_skills_dir: str = "skills/builtin",
    user_skills_dir: str = "skills/user",
    enable_hitl: bool = False,
) -> Agent:
    """
    Factory that wires auth, tools, hooks, skills, and session config.
    Returns a fully-configured Agent ready for start().
    """

    # 1. Auth
    auth = CopilotAuth(
        agency_cli_path=agency_cli_path,
        github_token=github_token,
    )

    # 2. Tools
    tool_registry = build_tool_registry()

    # 3. Hooks
    if enable_hitl:
        hitl = MyHitlHook()                 # subclass HitlHook
        hooks = {"on_pre_tool_use": hitl.on_pre_tool_use}
    else:
        hooks = {"on_pre_tool_use": auto_approve}

    # 4. Session config
    session_config = SessionConfig(
        model=model,
        streaming=True,
        tools=tool_registry.all(),
        skill_directories=[builtin_skills_dir, user_skills_dir],
        hooks=hooks,
        system_message={"mode": "replace", "content": "You are a helpful assistant."},
    )

    return Agent(auth, session_config)


# ── usage ─────────────────────────────────────────────────────────────────────

async def main() -> None:
    agent = await build_agent(
        agency_cli_path="~/.config/agency/CurrentVersion/agency",
        model="claude-sonnet-4.6",
    )
    await agent.start()

    response = await agent.send(
        "Summarize the latest project updates",
        on_delta=lambda chunk: print(chunk, end="", flush=True),
    )
    print(f"\n\nFinal: {response}")

    await agent.stop()
```

---

## Class Summary

| Class | File | Responsibility |
|---|---|---|
| `CopilotAuth` | `auth.py` | Builds `CopilotClient` opts for Agency CLI or token |
| `ManagedCopilotClient` | `client.py` | Client start/stop with retries + auth verification |
| `SessionConfig` | `session.py` | Typed session configuration with `.to_dict()` |
| `ToolRegistry` | `tools/__init__.py` | Collects base + optional tools; supports remove for sandbox |
| `HitlHook` | `hooks/hitl.py` | Base class for human-in-the-loop pre-tool approval |
| `EventHandler` | `events.py` | Dispatches SDK events; exposes `done` event and `final_text` |
| `Agent` | `agent.py` | Owns full lifecycle: start → session → send → stop |
| `SkillDirectoryLoader` | `skills.py` | Scans skill directories, parses SKILL.md frontmatter |
| `SkillInfo` | `skills.py` | Dataclass for a discovered skill's metadata |

---

## Key Patterns

**1. Auth priority** — agency CLI wins over token; absence of both → `gh` session fallback.

**2. Session recovery** — catch `"Session not found"` in `_send_inner`, call `new_session()`, retry once.

**3. Hook composition** — `compose_hooks(primary, secondary)` chains HITL before sandbox;
secondary only runs on primary `"allow"`.

**4. Tool definition** — always `@define_tool(description=...)` + single Pydantic param model.
Return a JSON-serialisable dict; raise `ValueError` for user-visible errors.

**5. Skills** — plain directories of `SKILL.md` files; pass paths in `skill_directories` at
session creation. The SDK picks them up automatically.

**6. One-shot vs session** — use `run_one_shot()` for background jobs; use `Agent` for
interactive multi-turn conversations where session history matters.

**7. Streaming** — pass `on_delta` to `agent.send()`; the `EventHandler` calls it for every
text chunk. Await `handler.done` for completion.
