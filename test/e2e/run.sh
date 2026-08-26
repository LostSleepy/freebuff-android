#!/bin/bash
# Regresión E2E del terminal command broker (tests oficiales del CLI).
#
# Los tests importan @codebuff/sdk y el módulo local del CLI, así que se
# ejecutan dentro de un checkout del source de Freebuff/Codebuff con bun.
# Este script:
#   1. Localiza el checkout (argumento, $CODEBUFF_SRC o sandbox/freebuff-src).
#   2. Copia test + fixtures vendored (regresión fiel a los oficiales).
#   3. Aplica el parche FREEBUFF_ANDROID_BROKER_SHIM (idempotente).
#   4. Ejecuta `bun test` sobre el test del broker.
#
# Uso:
#   bash test/e2e/run.sh [ruta/al/checkout-de-codebuff]
#
# Requisitos: bun (https://bun.sh) y las dependencias del checkout instaladas
# (`bun install` dentro del checkout).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# --- 1. Localizar el checkout del source del CLI ---------------------------
CHECKOUT="${1:-${CODEBUFF_SRC:-}}"
if [ -z "$CHECKOUT" ]; then
  DEFAULT="$ROOT/../../sandbox/freebuff-src/codebuff"
  if [ -d "$DEFAULT" ]; then
    CHECKOUT="$DEFAULT"
  else
    echo "❌ No se encontró checkout de codebuff. Pásalo como argumento:" >&2
    echo "   bash test/e2e/run.sh /ruta/al/checkout" >&2
    exit 1
  fi
fi
CHECKOUT="$(cd "$CHECKOUT" && pwd)"

UTILS_DIR="$CHECKOUT/cli/src/utils"
TEST_DIR="$UTILS_DIR/__tests__"
TEST_FILE="$TEST_DIR/terminal-command-broker.test.ts"
if [ ! -f "$TEST_FILE" ]; then
  echo "❌ $TEST_FILE no existe. ¿Es este un checkout del source del CLI?" >&2
  exit 1
fi

# --- 2. bun ----------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "❌ No se encontró bun. Instálalo (https://bun.sh) para correr la regresión E2E." >&2
  exit 1
fi

# --- 3. Copiar test + fixtures vendored (regresión) ------------------------
cp "$HERE/terminal-command-broker.test.ts" "$TEST_FILE"
mkdir -p "$TEST_DIR/fixtures"
cp "$HERE"/fixtures/terminal-command-broker-*.ts "$TEST_DIR/fixtures/"
echo "✓ Test y fixtures sincronizados con la copia vendored"

# --- 4. Aplicar el parche del broker (idempotente) -------------------------
node "$ROOT/patches/apply.js" "$UTILS_DIR"

# --- 5. Ejecutar -----------------------------------------------------------
echo "✓ Ejecutando bun test en $CHECKOUT"
cd "$CHECKOUT"
bun test "$TEST_FILE"
