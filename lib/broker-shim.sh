#!/bin/bash
# freebuff-broker-shim v2: Android/Termux broker entry point
# Created by the freebuff-android wrapper. Do not edit.
#
# grun runs the Bun binary via ld.so, so inside the binary process.execPath
# points at the loader and the terminal command broker cannot re-exec itself.
# This shim re-invokes grun with the real binary so the broker flag lands on
# the binary instead of the loader. The CLI must be built with the patch in
# patches/ so defaultBrokerInvocation() honours FREEBUFF_ANDROID_BROKER_SHIM.
GRUN="${FREEBUFF_ANDROID_GRUN:-grun}"
BIN="${FREEBUFF_ANDROID_BIN:?FREEBUFF_ANDROID_BIN not set}"
exec "$GRUN" "$BIN" "$@"
