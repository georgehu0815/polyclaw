/**
 * Local process deployment target.
 *
 * Starts and stops the polyclaw server directly via `scripts/polyclaw.sh`
 * without requiring Docker.  The server runs as a background daemon (nohup),
 * so it persists after the TUI exits — lifecycleTied is false.
 *
 * Admin secret is read from `.env` in the project root.
 */

import { resolve } from "path";
import type { DeployResult, LogStream } from "../config/types.js";
import type { DeployTarget } from "./target.js";
import { exec } from "./process.js";
import { waitForReady } from "./docker.js";

/** Repository root — four levels up from `app/tui/src/deploy/`. */
const PROJECT_ROOT = resolve(import.meta.dir, "../../../..");

const POLYCLAW_SH = resolve(PROJECT_ROOT, "scripts/polyclaw.sh");
const PID_FILE = resolve(PROJECT_ROOT, ".polyclaw.pid");
const LOG_FILE = resolve(PROJECT_ROOT, ".polyclaw.log");
const ENV_FILE = resolve(PROJECT_ROOT, ".env");

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/** Check whether the local server process is alive via the PID file. */
export async function isLocalRunning(): Promise<boolean> {
  try {
    const pidText = await Bun.file(PID_FILE).text();
    const pid = parseInt(pidText.trim(), 10);
    if (isNaN(pid)) return false;
    const { exitCode } = await exec(["kill", "-0", String(pid)]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Read ADMIN_PORT from .env, falling back to 9090. */
export async function readLocalPort(): Promise<number> {
  try {
    const content = await Bun.file(ENV_FILE).text();
    const match = content.match(/^ADMIN_PORT=(.+)$/m);
    if (match) {
      const port = parseInt(match[1].replace(/"/g, "").trim(), 10);
      if (!isNaN(port)) return port;
    }
  } catch { /* .env may not exist yet */ }
  return 9090;
}

/** Read ADMIN_SECRET from .env. */
export async function readLocalAdminSecret(): Promise<string> {
  try {
    const content = await Bun.file(ENV_FILE).text();
    const match = content.match(/^ADMIN_SECRET=(.+)$/m);
    if (match) return match[1].replace(/"/g, "").trim();
  } catch { /* .env may not exist yet */ }
  return "";
}

/**
 * Start the local server via `polyclaw.sh start`.
 *
 * Streams output to `onLine` when provided; otherwise inherits terminal.
 */
export async function startLocalServer(
  onLine?: (line: string) => void,
): Promise<void> {
  if (onLine) {
    const proc = Bun.spawn(["bash", POLYCLAW_SH, "start"], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) if (line.trim()) onLine(line);
      }
      if (buf.trim()) onLine(buf);
    };
    await Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`polyclaw.sh start exited with code ${code}`);
  } else {
    const proc = Bun.spawn(["bash", POLYCLAW_SH, "start"], {
      cwd: PROJECT_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`polyclaw.sh start exited with code ${code}`);
  }
}

/** Stop the local server via `polyclaw.sh stop`. */
export async function stopLocalServer(): Promise<void> {
  try {
    await exec(["bash", POLYCLAW_SH, "stop"], PROJECT_ROOT);
  } catch { /* already stopped */ }
}

/**
 * Stream the local server log file via `tail -f`.
 *
 * Tails the last 200 lines on attach, then follows new output.
 */
export function streamLocalLogs(
  _instanceId: string,
  onLine: (line: string) => void,
): LogStream {
  const proc = Bun.spawn(
    ["tail", "-f", "-n", "200", LOG_FILE],
    { stdout: "pipe", stderr: "pipe" },
  );

  let stopped = false;

  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) if (line.trim()) onLine(line);
      }
      if (buf.trim()) onLine(buf);
    } catch { /* killed */ }
  };

  drain(proc.stdout as ReadableStream<Uint8Array>);
  drain(proc.stderr as ReadableStream<Uint8Array>);

  return {
    stop() {
      stopped = true;
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// DeployTarget implementation
// ---------------------------------------------------------------------------

export class LocalDeployTarget implements DeployTarget {
  readonly name = "Local Process";
  /** Server persists after TUI exits — it is a background daemon. */
  readonly lifecycleTied = false;

  async deploy(
    _adminPort: number,
    _botPort: number,
    _mode: string,
    onLine?: (line: string) => void,
  ): Promise<DeployResult> {
    const running = await isLocalRunning();
    const port = await readLocalPort();
    const baseUrl = `http://localhost:${port}`;

    if (running) {
      onLine?.("Local server is already running — reconnecting.");
      return { baseUrl, instanceId: "local", reconnected: true };
    }

    await startLocalServer(onLine);
    return { baseUrl, instanceId: "local", reconnected: false };
  }

  streamLogs(instanceId: string, onLine: (line: string) => void): LogStream {
    return streamLocalLogs(instanceId, onLine);
  }

  async waitForReady(baseUrl: string, timeoutMs?: number): Promise<boolean> {
    return waitForReady(baseUrl, timeoutMs);
  }

  /** Leave the server running when the TUI exits. */
  async disconnect(_instanceId: string): Promise<void> {}

  async getAdminSecret(_instanceId?: string): Promise<string> {
    return readLocalAdminSecret();
  }

  async resolveKvSecret(secret: string, _instanceId?: string): Promise<string> {
    // No KV infrastructure for local — return value as-is (or strip @kv: prefix).
    if (!secret.startsWith("@kv:")) return secret;
    return this.getAdminSecret();
  }
}
