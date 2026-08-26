# Freebuff Android/Termux — Unofficial Android compatibility layer

> ⚠️ **Unofficial layer.** This project is not affiliated with, endorsed by, or
> sponsored by Codebuff/Freebuff. It is a community-made compatibility layer
> that **runs the official Freebuff Linux ARM64 binary** on Android/Termux via
> `glibc-runner` (`grun`) — no PRoot, no emulation. **Android is not officially
> supported by Freebuff**; this is a compatibility port, not an official
> product.

- Uses the binary published by Freebuff itself in their official releases
  (`CodebuffAI/codebuff-community`) — never third-party binaries.
- Requires **Termux + `glibc-runner`** (glibc-repo) and an ARM64 (aarch64)
  device.
- Verifies the **SHA-256** of the archive against the digest published by
  GitHub before installing.
- **Rolls back** if the download/update is corrupt or the new binary fails to
  start.
- Ships a **`grun`-specific terminal command broker shim** (see `patches/`).

## Status: verified on real Android hardware

Tested on a real Termux device (ARM64 / aarch64) over SSH:

- `freebuff --version` → `0.0.156 (android wrapper 0.2.0)`.
- Real **51 MB download** from GitHub with **SHA-256 matching** the official
  release digest.
- **ELF AArch64** header validated before install.
- `android-doctor`: environment, binary, integrity, shim and **minimal broker
  E2E all pass** (the binary answers `--terminal-command-broker`).
- Shim preserved across an update.
- The binary's `--version` and `--help` work through `grun`.
- **The full TUI launches and renders** (project folder picker).
- 21/21 unit tests pass on the phone itself.

## Known limitation: SIGSYS when terminating the TUI

When the TUI is **terminated from outside** (e.g. `kill -TERM` or a timeout),
the Bun binary dies with `SIGSYS` / "Bad system call" during teardown — a
syscall blocked by Android's seccomp (likely Bun's io_uring/rseq on exit).
**It does not affect the TUI while it is running** (it has run stably for
minutes inside a tmux session on the device).

Pending on-screen verification: whether exiting the TUI the normal way
(`q` / `Esc`) also triggers it. If it only happens with an external `SIGTERM`,
it is a limitation of external signal handling, not a functional failure of
the wrapper or the port.

## Requirements

- Android ARM64 (aarch64) with [Termux](https://termux.dev).
- Node.js ≥ 18 inside Termux.

## Install

```bash
pkg update
pkg install nodejs
pkg install glibc-repo glibc-runner

# from the project folder:
npm install -g .
# or once published:
npm install -g freebuff-android
```

The first launch downloads `freebuff-linux-arm64.tar.gz` from the official
`latest` release, verifies its SHA-256 against the digest published by GitHub,
and installs the binary into `~/.config/manicode/`.

## Usage

```bash
freebuff                 # Run Freebuff (installs/updates if needed)
freebuff --version       # Wrapper and installed binary versions
freebuff android-setup   # Check/repair glibc-runner and install the binary
freebuff android-update  # Force an update
freebuff android-doctor  # Full diagnostics (see below)
freebuff android-clean   # Remove the launcher's download cache
```

The wrapper checks the `latest` release on every launch, so it is never pinned
to an old version.

## Update integrity and security

The install/update flow (`installOrUpdate`) does, in order:

1. **Official releases only**: looks for `freebuff-linux-arm64.tar.gz` in the
   `latest` release of `CodebuffAI/codebuff-community`.
2. **Digest required**: if the release does not publish a valid SHA-256 digest,
   the install is rejected (never installs blindly).
3. **Archive SHA-256** against the digest published by GitHub. On mismatch the
   download is discarded and the previous version is kept.
4. **Extracted binary validation**: ELF header must be ARM64 (aarch64).
5. **Backup + atomic replace**: the previous binary is copied to
   `freebuff.previous` before replacement.
6. **Smoke test**: the new binary is started (`--version`). If it fails to
   load or dies on execution, the **previous version is restored** and the
   metadata is left untouched.
7. Metadata is written atomically and **only after** the smoke test passes.
8. The **broker shim is re-verified at the end**, so an update can never leave
   it missing, stale, or non-executable.

If the network is down or GitHub fails, the installed version is kept. The
wrapper never auto-downgrades a working install.

## The terminal command broker and the shim

Freebuff runs terminal commands through a "broker": the CLI re-executes itself
with `--terminal-command-broker` using `process.execPath`. On Android, `grun`
launches the Bun binary through `ld.so`, so inside the binary
`process.execPath` points at the loader, not the binary, and the broker cannot
re-execute itself.

The wrapper solves this:

- Creates a **shim** (`~/.config/manicode/freebuff-broker-shim`, see
  `lib/broker-shim.sh`) that re-invokes `grun` with the real binary.
- Exposes it to the binary via `FREEBUFF_ANDROID_BROKER_SHIM` (+
  `FREEBUFF_ANDROID_BIN` and `FREEBUFF_ANDROID_GRUN`).
- The CLI must be built with the **patch** in `patches/` so
  `defaultBrokerInvocation()` honours that variable. In the hardware test the
  minimal broker E2E passed with the official 0.0.156 binary through the shim.

```bash
# Apply the patch to a CLI source checkout (idempotent):
node patches/apply.js /path/to/checkout/cli/src/utils
```

### `android-doctor`

Diagnoses the environment and runs a **minimal broker E2E**:

- Android, architecture, `$PREFIX`, Node, `glibc-runner`.
- Binary: presence, ELF ARM64 header, permissions and integrity (hash).
- Metadata: version, target, source.
- **Broker shim**: existence, canonical content, exec permission (and repairs
  it if needed).
- **Minimal E2E test**: starts the binary through the shim with the broker
  flag and checks it answers via the protocol file. If the binary does not
  support it, it says so clearly.

## Paths

All paths are derived dynamically from `$HOME` / `$PREFIX` / `TMPDIR`. No
hardcoded install paths:

| Item | Path |
|---|---|
| Config | `$HOME/.config/manicode/` |
| Binary | `$HOME/.config/manicode/freebuff` |
| Metadata | `$HOME/.config/manicode/freebuff-android-metadata.json` |
| Shim | `$HOME/.config/manicode/freebuff-broker-shim` |
| Download cache | `$HOME/.config/manicode/.freebuff-android-download/` (self-cleaning) |

## Project structure

```
freebuff-android/
├── index.js                  # Definitive launcher (`freebuff` entry point)
├── lib/broker-shim.sh        # Canonical shim copy (verified by tests)
├── patches/
│   ├── terminal-command-broker.patch.ts   # CLI patch documentation
│   └── apply.js              # Idempotent patch applier
├── test/
│   ├── unit/                 # Wrapper tests (node:test, no network)
│   └── e2e/                  # Broker E2E regression (official tests + fixtures)
├── package.json
├── README.md
└── LICENSE
```

## Tests

```bash
npm test        # Wrapper unit tests (node --test)
npm run check   # Syntax check of index.js and patches/apply.js

# Broker E2E regression (requires bun + a CLI source checkout):
bash test/e2e/run.sh /path/to/codebuff-checkout
```

## Limitations

- It does not turn Android into Linux: it runs the official Linux ARM64 binary
  with `glibc-runner`. If the binary depends on syscalls or functions missing
  or incompatible with Android, it will need fixing (see `android-doctor` and
  the SIGSYS limitation above).
- No PRoot, no emulation, no full Linux distribution.
- The broker shim worked in the hardware test with the **official 0.0.156
  binary** (broker E2E passed). The patch in `patches/` is kept documented for
  custom CLI builds and as reference.
- ARM64 only; no x86 Android support.

## License

MIT. See [LICENSE](./LICENSE).

---

*Freebuff and Codebuff are trademarks of their respective owners. This project
is independent and not endorsed by them.*
