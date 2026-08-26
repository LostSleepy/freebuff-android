#!/usr/bin/env node
'use strict';

/**
 * Aplica (de forma idempotente) el parche del terminal command broker a un
 * checkout del source del CLI de Freebuff/Codebuff.
 *
 * Uso:
 *   node patches/apply.js [ruta/al/checkout]        # por defecto: cli/src/utils
 *   node patches/apply.js --check [ruta/...]        # solo comprueba sin tocar
 *
 * El parche modifica cli/src/utils/terminal-command-broker.ts para que
 * defaultBrokerInvocation() use FREEBUFF_ANDROID_BROKER_SHIM (el shim que
 * crea el wrapper) en lugar de process.execPath cuando se ejecuta bajo grun.
 * Ver patches/terminal-command-broker.patch.ts para la explicación completa.
 *
 * El binario oficial solo respeta el shim si se compiló con este parche.
 */

const fs = require('fs');
const path = require('path');

const FS_IMPORT_ORIGINAL = "import { readFileSync, rmSync, writeFileSync } from 'fs'";
const FS_IMPORT_PATCHED = "import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'";

const FUNCTION_ORIGINAL = `function defaultBrokerInvocation(): {
  executable: string
  args: string[]
} {
  return {
    executable: process.execPath,
    args:
      getCliEnv().CODEBUFF_IS_BINARY === 'true'
        ? [TERMINAL_COMMAND_BROKER_FLAG]
        : [
            path.join(import.meta.dir, '..', 'entry.ts'),
            TERMINAL_COMMAND_BROKER_FLAG,
          ],
  }
}`;

const FUNCTION_PATCHED = `function defaultBrokerInvocation(): {
  executable: string
  args: string[]
} {
  // Android/Termux: process.execPath may point to ld.so when invoked via grun.
  // Use a shim script that re-invokes grun with the real binary instead.
  const androidBrokerShim = getSystemProcessEnv().FREEBUFF_ANDROID_BROKER_SHIM
  if (androidBrokerShim && existsSync(androidBrokerShim)) {
    return {
      executable: androidBrokerShim,
      args: [TERMINAL_COMMAND_BROKER_FLAG],
    }
  }

  return {
    executable: process.execPath,
    args:
      getCliEnv().CODEBUFF_IS_BINARY === 'true'
        ? [TERMINAL_COMMAND_BROKER_FLAG]
        : [
            path.join(import.meta.dir, '..', 'entry.ts'),
            TERMINAL_COMMAND_BROKER_FLAG,
          ],
  }
}`;

const MARKER = 'FREEBUFF_ANDROID_BROKER_SHIM';

function resolveTargetDir(argvPath) {
  if (argvPath) return path.resolve(argvPath);
  const here = path.resolve(__dirname);
  const candidate = path.join(here, '..', 'cli', 'src', 'utils');
  return fs.existsSync(candidate) ? candidate : here;
}

function main() {
  const args = process.argv.slice(2);
  const onlyCheck = args[0] === '--check';
  const targetArg = onlyCheck ? args[1] : args[0];
  const utilsDir = resolveTargetDir(targetArg);
  const file = path.join(utilsDir, 'terminal-command-broker.ts');

  if (!fs.existsSync(file)) {
    console.error(`❌ No se encuentra ${file}`);
    console.error('   Pasa la ruta del checkout: node patches/apply.js /ruta/al/cli/src/utils');
    process.exit(1);
  }

  const source = fs.readFileSync(file, 'utf8');

  if (source.includes(MARKER)) {
    console.log(`✓ Ya está parcheado (contiene ${MARKER}): ${file}`);
    return;
  }

  if (onlyCheck) {
    console.log(`✗ Sin parchear: ${file}`);
    process.exit(1);
  }

  let patched = source;

  if (patched.includes(FS_IMPORT_ORIGINAL)) {
    patched = patched.split(FS_IMPORT_ORIGINAL).join(FS_IMPORT_PATCHED);
  } else if (!patched.includes('existsSync')) {
    // El import de 'fs' cambió de forma; añade existsSync en una línea nueva.
    patched = patched.replace(
      /(import \{ [^}]*\} from 'fs')/,
      `$1\nimport { existsSync } from 'fs'`,
    );
  }

  if (!patched.includes(FUNCTION_ORIGINAL)) {
    console.error('❌ No se encontró el defaultBrokerInvocation() original (¿versión distinta?).');
    console.error('   Revisa patches/terminal-command-broker.patch.ts y aplica a mano.');
    process.exit(1);
  }
  patched = patched.split(FUNCTION_ORIGINAL).join(FUNCTION_PATCHED);

  fs.writeFileSync(file, patched);
  console.log(`✓ Parche aplicado: ${file}`);
  console.log('  - Import de fs: añadido existsSync');
  console.log('  - defaultBrokerInvocation(): usa FREEBUFF_ANDROID_BROKER_SHIM');
}

main();
