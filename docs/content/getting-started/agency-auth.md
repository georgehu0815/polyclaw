---
title: "Agency Authentication"
weight: 4
---

# Agency Authentication

[Agency](https://aka.ms/agency) is the Microsoft Agent Platform — a unified CLI that provides access to GitHub Copilot, Claude Code, and other AI models. When Agency is installed, Polyclaw uses it as the preferred authentication method instead of a `GITHUB_TOKEN` or `gh auth login`.

## Why Agency?

| Method | What it needs | When to use |
|---|---|---|
| **Agency CLI** | Agency installed at `~/.config/agency/` | Preferred on developer machines; handles auth automatically |
| `GITHUB_TOKEN` env var | A GitHub PAT | CI/CD, containers, automated environments |
| `gh auth login` | GitHub CLI installed and authenticated | Fallback when neither Agency nor a token is available |

Agency authenticates with GitHub Copilot using its own credential store — no token management required. Polyclaw auto-detects it at startup.

## Installing Agency

Agency is distributed as a single self-updating binary. Installation varies by platform.

### macOS / Linux

```bash
curl -fsSL https://aka.ms/agency/install | bash
```

This installs the binary to `~/.config/agency/CurrentVersion/agency` and adds a shell alias. Verify the installation:

```bash
agency --version
```

### Windows

```powershell
winget install Microsoft.Agency
```

Or use the shell installer in PowerShell:

```powershell
iwr https://aka.ms/agency/install | iex
```

### Verify

```bash
agency copilot --version
```

If you see a version string, Agency is correctly installed and the Copilot subcommand is available.

## Authentication

Agency uses its own auth flow. Sign in once:

```bash
agency copilot
```

The first run prompts you to authenticate with your GitHub account. After that, the credential is stored locally and reused automatically.

To check your authentication status:

```bash
agency copilot status
```

## How Polyclaw Detects Agency

At startup, Polyclaw checks for the Agency binary in this order:

1. **`AGENCY_CLI_PATH` env var** — if set, uses that path directly
2. **Default path** — `~/.config/agency/CurrentVersion/agency`

If the binary exists at either location, Polyclaw passes `cli_path` and `cli_args: ["copilot"]` to the Copilot SDK instead of a token. No `GITHUB_TOKEN` is read or required.

```
# To override the default path, add to your .env:
AGENCY_CLI_PATH=/custom/path/to/agency
```

## Setup Wizard

When Agency is detected, the GitHub step in the Setup Wizard shows **Authenticated via Agency** — no device code flow or token entry is needed. Click **Continue** to move to the next step.

If Agency is _not_ detected, the wizard falls back to the standard GitHub device code flow.

## Fallback Authentication

If Agency is not installed, Polyclaw falls back in this order:

1. `GITHUB_TOKEN` in `.env` or environment
2. Active `gh auth login` session (GitHub CLI)

Add a token to `.env`:

```bash
GITHUB_TOKEN=ghp_your_personal_access_token
```

The token needs the `copilot` scope. Generate one at https://github.com/settings/tokens with `copilot` selected.

## Keeping Agency Updated

Agency ships a self-update command:

```bash
agency update
```

Polyclaw will automatically use the new version on next restart since it reads the `CurrentVersion` symlink at runtime.

## Troubleshooting

**`agency` not found after install**

The installer adds a shell function. Reload your shell or open a new terminal:

```bash
source ~/.bashrc   # or ~/.zshrc
```

Or call the binary directly:

```bash
~/.config/agency/CurrentVersion/agency --version
```

**Agency installed but Polyclaw still shows "No GITHUB_TOKEN"**

Check that the binary exists at the expected path:

```bash
ls ~/.config/agency/CurrentVersion/agency
```

If Agency is in a non-standard location, set `AGENCY_CLI_PATH` in your `.env`:

```bash
AGENCY_CLI_PATH=/path/to/agency
```

Restart the server after changing `.env`:

```bash
./scripts/polyclaw.sh restart
```

**Verify auth at runtime**

Check the `/api/setup/copilot/status` endpoint:

```bash
curl -s http://localhost:9090/api/setup/copilot/status \
  -H "Authorization: Bearer <admin-secret>" | jq .
```

When Agency is active, the response will include `"auth_method": "agency"`.
