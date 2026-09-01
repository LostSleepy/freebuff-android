# Freebuff Android/Termux — Unofficial Android compatibility layer

> ⚠️ **Unofficial layer.** This project is not affiliated with, endorsed by, or
> sponsored by Codebuff/Freebuff. It is a community-made compatibility layer
> that **runs the official Freebuff Linux ARM64 binary** on Android/Termux —
> in direct mode (patched ELF interpreter + no `LD_PRELOAD`) or via
> `glibc-runner` (`grun`) as fallback — no PRoot, no emulation. **Android is
> not officially supported by Freebuff**; this is a compatibility port, not an
> official product.

- Uses the binary published by Freebuff itself in their official releases
  (`CodebuffAI/codebuff-community`) — never third-party binaries.
- Requires **Termux + `glibc-runner`** (glibc-repo) and an ARM64 (aarch64)
  device.
- Verifies the **SHA-256** of the archive against the digest published by
  GitHub before installing.
- **Rolls back** if the download/update is corrupt or the new binary fails to
  start.
- Runs the official binary in **direct mode** (rewrites its ELF interpreter
  with a bundled `patchelf` and drops `LD_PRELOAD`), which makes the
  **terminal command broker work without patching the CLI source**.
- Ships an **LD_PRELOAD DNS shim** that gives Bun's internal resolver a
  working `/etc/resolv.conf`, fixing `read_url` and any in-binary
  hostname resolution on Android.

## Direct execution mode (v0.3.0)

The official binary expects the interpreter `/lib/ld-linux-aarch64.so.1`, a
path that does not exist on Android. `glibc-runner` works around it by
launching the binary through `ld.so`, but then `process.execPath` points at
`ld.so` and the terminal command broker cannot re-execute itself — so running
terminal commands inside Freebuff failed with "terminal command broker protocol
response was missing".

The wrapper fixes this without touching the CLI source:

1. After install/update it rewrites the binary's **ELF interpreter**
   (`patchelf --set-interpreter`) to the real glibc loader of `glibc-runner`
   (`$PREFIX/glibc/lib/ld-linux-aarch64.so.1`), verified with a direct smoke
   test before replacing the binary.
2. It runs the binary **directly** (no `grun`) with **`LD_PRELOAD` removed**
   (Termux's `libtermux-exec-ld-preload.so` breaks the loader's library
   resolution; `glibc-runner` does the same unset).
3. Now `process.execPath` is the binary itself, so the broker re-executes it
   correctly and terminal commands work with the **official, unpatched
   binary**. Verified on hardware: `Broker E2E (directa): ok, exitCode 0`.

If `patchelf` or the direct smoke test fails, the wrapper falls back to
`grun` mode (the TUI works, but terminal commands are unavailable).

## Android DNS shim (v0.4.0)

Some in-binary features resolve DNS with Bun's internal resolver, which reads
`/etc/resolv.conf` **literally**. On Android that file does not exist (only
root could create it), so the resolver falls back to `127.0.0.1:53` and every
hostname lookup dies with `getaddrinfo ETIMEOUT` — that is exactly why the
`read_url` tool fails on-device while working on desktop (which has a real
`/etc/resolv.conf`).

The wrapper ships a tiny `LD_PRELOAD` shim (`lib/dns-redirect-aarch64.so`,
source in `lib/dns-redirect.c`) that intercepts `open`/`openat`/`stat`/etc.
and redirects `/etc/resolv.conf` to `$PREFIX/etc/resolv.conf` (the
`glibc-runner` one, already pointing at reachable nameservers — direct UDP
DNS works fine from Android apps). No root, no PRoot, no daemons. Verified
with real Bun 1.3.14 (the runtime embedded in the binary): `dns.lookup` went
from `ETIMEOUT` (~25 s) to OK (~50 ms).

- Only active in **direct mode** (`grun` strips `LD_PRELOAD` by design).
- Disable it with `FREEBUFF_ANDROID_NO_DNS_SHIM=1`.
- Not needed on OSes that already have `/etc/resolv.conf` (desktop).

## Status: verified on real Android hardware

Tested on a real Termux device (ARM64 / aarch64) over SSH:

- `freebuff --version` → `0.0.156 (android wrapper 0.2.0)`.
- Real **51 MB download** from GitHub with **SHA-256 matching** the official
  release digest.
- **ELF AArch64** header validated before install.
- `android-doctor`: environment, binary, integrity, shim and **minimal broker
  E2E all pass** — including in **direct mode** (the binary answers
  `--terminal-command-broker` with `exitCode 0`, so terminal commands work).
- Shim preserved across an update.
- The binary's `--version` and `--help` work both through `grun` and in
  direct mode.
- **The full TUI launches and renders** (project folder picker).
- 28/28 unit tests pass on the phone itself.

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

## The terminal command broker

Freebuff runs terminal commands through a "broker": the CLI re-executes itself
with `--terminal-command-broker` using `process.execPath`. Under `grun` that
path points at `ld.so` and the broker cannot re-execute itself. The wrapper
solves it in **direct mode** (see above): the binary runs with
`process.execPath` = itself, so the broker just works with the official
binary.

For completeness, the wrapper still ships a **`grun` shim**
(`~/.config/manicode/freebuff-broker-shim`, see `lib/broker-shim.sh`) and a
**CLI source patch** (`patches/`, applier `patches/apply.js`) that make the
broker work through `FREEBUFF_ANDROID_BROKER_SHIM` for custom CLI builds:

```bash
# Apply the patch to a CLI source checkout (idempotent):
node patches/apply.js /path/to/checkout/cli/src/utils
```

Direct mode is preferred: it needs no patch and works with the official
release binary.

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

`patchelf` (aarch64) is bundled in the npm package (`lib/patchelf-aarch64`);
no extra install needed.

## Project structure

```
freebuff-android/
├── index.js                  # Definitive launcher (`freebuff` entry point)
├── lib/broker-shim.sh        # Canonical shim copy (verified by tests)
├── lib/patchelf-aarch64      # Bundled patchelf (ARM64) for direct mode
├── lib/dns-redirect.c        # DNS shim source (LD_PRELOAD)
├── lib/dns-redirect-aarch64.so  # Compiled DNS shim (ARM64)
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
  (directly, or via `glibc-runner` as fallback). If the binary depends on
  syscalls or functions missing or incompatible with Android, it will need
  fixing (see `android-doctor` and the SIGSYS limitation above).
- No PRoot, no emulation, no full Linux distribution.
- Direct mode requires `glibc-runner`'s glibc loader (installed by
  `pkg install glibc-repo glibc-runner`); if it is missing, the wrapper falls
  back to `grun` mode where terminal commands are unavailable.
- ARM64 only; no x86 Android support.

## License

MIT. See [LICENSE](./LICENSE).

---

*Freebuff and Codebuff are trademarks of their respective owners. This project
is independent and not endorsed by them.*
