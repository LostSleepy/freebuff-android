#!/usr/bin/env node
'use strict';

/**
 * freebuff-android — launcher NO oficial para Android/Termux.
 *
 * Descarga el binario oficial Linux ARM64 de Freebuff desde las releases de
 * GitHub (CodebuffAI/codebuff-community), verifica su SHA-256 y lo ejecuta
 * mediante glibc-runner (`grun`), sin PRoot ni emulación.
 *
 * Este wrapper NO está afiliado con Codebuff/Freebuff: usa el binario oficial
 * publicado por ellos, pero toda la lógica de arranque, shim del broker y
 * actualización es de este proyecto.
 *
 * Estructura del paquete:
 *   index.js               Este launcher (punto de entrada `freebuff`)
 *   lib/broker-shim.sh     Copia canónica del shim (debe coincidir con el
 *                          template embebido; test/unit lo verifica)
 *   patches/               Parche del lado CLI (terminal command broker)
 *   test/                  Tests unitarios (node) y E2E (bun, del broker)
 *
 * El módulo se puede requerir para tests: `createWrapper({ ... })` devuelve la
 * API interna con E/S inyectable. Solo se ejecuta `main()` cuando se invoca
 * como binario (`require.main === module`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const tar = require('tar');

const WRAPPER_VERSION = '0.2.0';
const PACKAGE = 'freebuff';
const DISPLAY_NAME = 'Freebuff';
const RELEASE_REPO = 'CodebuffAI/codebuff-community';
const ASSET_NAME = 'freebuff-linux-arm64.tar.gz';
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

// e_machine AARCH64 en la cabecera ELF (offset 18, little-endian).
const ELF_AARCH64 = 183;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

const SHIM_MARKER = 'freebuff-broker-shim';

/**
 * Template canónico del shim del broker. Debe coincidir EXACTAMENTE con
 * lib/broker-shim.sh (lo verifica test/unit/shim-template.test.js).
 *
 * Por qué existe: `grun` ejecuta el binario Bun a través de ld.so, por lo que
 * dentro del binario process.execPath apunta al loader y el terminal command
 * broker no puede re-ejecutarse a sí mismo. El shim re-invoca grun con el
 * binario real, de modo que el flag --terminal-command-broker llega al binario
 * y no al loader. El CLI debe estar compilado con el parche de patches/ para
 * leer FREEBUFF_ANDROID_BROKER_SHIM; sin él, el shim no hace nada.
 */
const BROKER_SHIM_TEMPLATE = [
  '#!/bin/bash',
  `# ${SHIM_MARKER} v2: Android/Termux broker entry point`,
  '# Created by the freebuff-android wrapper. Do not edit.',
  '#',
  '# grun runs the Bun binary via ld.so, so inside the binary process.execPath',
  '# points at the loader and the terminal command broker cannot re-exec itself.',
  '# This shim re-invokes grun with the real binary so the broker flag lands on',
  '# the binary instead of the loader. The CLI must be built with the patch in',
  '# patches/ so defaultBrokerInvocation() honours FREEBUFF_ANDROID_BROKER_SHIM.',
  'GRUN="${FREEBUFF_ANDROID_GRUN:-grun}"',
  'BIN="${FREEBUFF_ANDROID_BIN:?FREEBUFF_ANDROID_BIN not set}"',
  'exec "$GRUN" "$BIN" "$@"',
  '',
].join('\n');

/**
 * Configuración derivada dinámicamente de $HOME / $PREFIX.
 * No hay rutas de instalación hardcodeadas: todo cuelga de ~/.config/manicode
 * (el mismo directorio que usa el launcher oficial de Freebuff) o de TMPDIR.
 */
function createConfig(env = process.env, homedir = os.homedir) {
  const home = env.HOME || homedir();
  const configDir = path.join(home, '.config', 'manicode');
  return {
    home,
    configDir,
    binaryPath: path.join(configDir, PACKAGE),
    metadataPath: path.join(configDir, `${PACKAGE}-android-metadata.json`),
    tempDir: path.join(configDir, `.${PACKAGE}-android-download`),
    shimPath: path.join(configDir, `${PACKAGE}-broker-shim`),
    backupPath: path.join(configDir, `${PACKAGE}.previous`),
    // Solo detección: nunca se escribe en esta ruta.
    termuxUsrPrefix: '/data/data/com.termux/files/usr',
  };
}

function isAndroid(env = process.env, fsImpl = fs) {
  return (
    env.PREFIX === '/data/data/com.termux/files/usr' ||
    Boolean(env.TERMUX_VERSION) ||
    fsImpl.existsSync('/system/bin/getprop')
  );
}

function isArm64() {
  return process.arch === 'arm64' || process.arch === 'aarch64';
}

/** Comparador semver numérico simple ("1.2.3" vs "1.10.0"). */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/** E/S inyectable para poder testear sin red ni disco real. */
function defaultIo({
  env = process.env,
  spawnSyncFn = spawnSync,
  spawnFn = spawn,
  fsImpl = fs,
  tmpdirFn = os.tmpdir,
} = {}) {
  const die = (msg) => {
    const e = new Error(msg);
    e.exit = 1;
    return e;
  };

  return {
    die,

    runner() {
      for (const cmd of ['grun', 'glibc-runner']) {
        const r = spawnSyncFn(cmd, ['--version'], { stdio: 'ignore' });
        // status === 0 → existe. ENOENT → no existe; cualquier otro error
        // (p.ej. EACCES) cuenta como "existe pero falla" y se reporta igual.
        if (r.status === 0 || r.error?.code !== 'ENOENT') return cmd;
      }
      return null;
    },

    getJson(url) {
      return new Promise((resolve, reject) => {
        const req = https.get(
          url,
          {
            headers: {
              'User-Agent': `${PACKAGE}-android/${WRAPPER_VERSION}`,
              Accept: 'application/vnd.github+json',
            },
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  resolve(JSON.parse(data));
                } catch (e) {
                  reject(new Error(`Respuesta JSON inválida de GitHub: ${e.message}`));
                }
              } else {
                reject(
                  new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`),
                );
              }
            });
          },
        );
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('timeout consultando GitHub')));
      });
    },

    download(url, dest) {
      return new Promise((resolve, reject) => {
        fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fsImpl.createWriteStream(dest);
        const req = https.get(
          url,
          { headers: { 'User-Agent': `${PACKAGE}-android/${WRAPPER_VERSION}` } },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              file.close();
              fsImpl.unlinkSync(dest);
              return this.download(res.headers.location, dest).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
              file.close();
              fsImpl.unlink(dest, () => {});
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
          },
        );
        req.on('error', (e) => {
          file.close();
          fsImpl.unlink(dest, () => {});
          reject(e);
        });
      });
    },

    sha256(file) {
      const h = crypto.createHash('sha256');
      return new Promise((resolve, reject) => {
        const s = fsImpl.createReadStream(file);
        s.on('error', reject);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
      });
    },

    extract(archive, destDir) {
      return tar.x({ file: archive, cwd: destDir });
    },

    /**
     * Busca el ejecutable "freebuff" dentro del árbol extraído. Prefiere la
     * copia más superficial (el tarball oficial lo lleva en la raíz).
     */
    findBinary(rootDir) {
      const candidates = [];
      const walk = (d, depth) => {
        for (const n of fsImpl.readdirSync(d)) {
          const p = path.join(d, n);
          const s = fsImpl.statSync(p);
          if (s.isDirectory()) walk(p, depth + 1);
          else if (n === PACKAGE) candidates.push({ p, depth });
        }
      };
      try {
        walk(rootDir, 0);
      } catch {
        return null;
      }
      candidates.sort((a, b) => a.depth - b.depth);
      return candidates[0]?.p || null;
    },

    /**
     * Valida la cabecera ELF del binario y devuelve su e_machine.
     * null → no es un ELF válido.
     */
    readElfMachine(file) {
      try {
        const head = fsImpl.readFileSync(file).subarray(0, 20);
        if (head.length < 20 || !head.subarray(0, 4).equals(ELF_MAGIC)) {
          return null;
        }
        return head.readUInt16LE(18);
      } catch {
        return null;
      }
    },

    /**
     * Smoke test del binario recién instalado: debe arrancar y salir por sí
     * solo (o agotar nuestro timeout, lo que demuestra que cargó). Cualquier
     * fallo de carga (ENOEXEC, segfault, SIGILL...) lo rechaza.
     */
    smokeTest(runnerCmd, bin) {
      let r;
      try {
        // `--version` está implementado por Commander en el CLI oficial y
        // sale rápido con código 0.
        r = spawnSyncFn(runnerCmd, [bin, '--version'], {
          timeout: 20000,
          stdio: 'ignore',
        });
      } catch {
        return false;
      }
      if (r.error) {
        // ETIMEDOUT: arrancó y corrió hasta nuestro timeout → OK.
        return r.error.code === 'ETIMEDOUT';
      }
      if (r.signal && !['SIGKILL', 'SIGTERM'].includes(r.signal)) return false;
      return true;
    },

    /**
     * E2E mínimo del broker (usado por android-doctor): arranca el binario a
     * través del shim con el flag de broker y comprueba que responde por el
     * archivo de protocolo. Devuelve { ok, detail }.
     */
    brokerE2E(runnerCmd, bin, shimPath, { config, env: envArg = env } = {}) {
      const protocolFile = path.join(
        tmpdirFn(),
        `freebuff-terminal-command-broker-${process.pid}-${crypto.randomUUID()}.json`,
      );
      const request = {
        executable: '/bin/sh',
        args: ['-c', 'printf broker-e2e-ok; exit 0'],
        cwd: envArg.HOME || '/',
        env: { PATH: envArg.PATH || '/usr/bin:/bin' },
      };
      return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let child;
        const finish = (ok, detail) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          try {
            fsImpl.unlinkSync(protocolFile);
          } catch {}
          resolve({ ok, detail });
        };

        try {
          child = spawnFn(shimPath, ['--terminal-command-broker'], {
            stdio: ['pipe', 'inherit', 'inherit'],
            env: {
              ...envArg,
              CODEBUFF_TERMINAL_COMMAND_BROKER: '1',
              CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL: protocolFile,
              FREEBUFF_ANDROID_BIN: bin,
              FREEBUFF_ANDROID_GRUN: runnerCmd,
              FREEBUFF_ANDROID_BROKER_SHIM: shimPath,
            },
          });
        } catch (e) {
          return finish(false, `No se pudo lanzar el shim: ${e.message}`);
        }
        child.on('error', (e) => finish(false, `Error al lanzar el shim: ${e.message}`));
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(request));

        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          finish(false, 'Timeout esperando la respuesta del broker (¿el binario tiene aplicado el parche del broker?)');
        }, 20000);

        const deadline = Date.now() + 20000;
        const poll = () => {
          if (settled) return;
          if (fsImpl.existsSync(protocolFile)) {
            try {
              const payload = JSON.parse(
                fsImpl.readFileSync(protocolFile, 'utf8').trim(),
              );
              if (payload.ok === true && payload.exitCode === 0) {
                finish(true, 'El broker respondió ok con exitCode 0');
              } else {
                finish(false, `El broker respondió: ${JSON.stringify(payload)}`);
              }
            } catch (e) {
              finish(false, `Archivo de protocolo inválido: ${e.message}`);
            }
            return;
          }
          if (Date.now() > deadline) {
            try {
              child.kill('SIGKILL');
            } catch {}
            finish(false, 'Timeout: no apareció el archivo de protocolo');
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
    },
  };
}

function createWrapper({
  env = process.env,
  config = createConfig(env),
  io = defaultIo({ env }),
  fsImpl = fs,
} = {}) {
  const { die } = io;

  function readMeta() {
    try {
      return JSON.parse(fsImpl.readFileSync(config.metadataPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeMeta(m) {
    fsImpl.mkdirSync(config.configDir, { recursive: true });
    // Escritura atómica: nunca dejar un metadata a medias.
    const tmp = `${config.metadataPath}.tmp.${process.pid}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fsImpl.renameSync(tmp, config.metadataPath);
  }

  function writeFileAtomic(file, content, mode) {
    const tmp = `${file}.tmp.${process.pid}`;
    fsImpl.writeFileSync(tmp, content, { mode });
    fsImpl.chmodSync(tmp, mode);
    fsImpl.renameSync(tmp, file);
  }

  function isExecutable(file) {
    try {
      fsImpl.accessSync(file, fsImpl.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Crea/repara el shim del broker. Se re-ejecuta en cada lanzamiento y
   * después de cada actualización, de modo que una actualización de Freebuff
   * nunca puede dejar el shim ausente, obsoleto o sin permiso de ejecución.
   * Se reescribe si el contenido difiere del template canónico.
   */
  function ensureBrokerShim() {
    fsImpl.mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
    let current = null;
    try {
      current = fsImpl.readFileSync(config.shimPath, 'utf8');
    } catch {}
    const valid =
      current === BROKER_SHIM_TEMPLATE && isExecutable(config.shimPath);
    if (!valid) {
      writeFileAtomic(config.shimPath, BROKER_SHIM_TEMPLATE, 0o755);
    }
    return config.shimPath;
  }

  /** Última release oficial y su digest SHA-256 (obligatorio). */
  async function latest() {
    const r = await io.getJson(RELEASE_API);
    const asset = r.assets?.find((a) => a.name === ASSET_NAME);
    if (!asset) {
      throw new Error(`La release actual no contiene ${ASSET_NAME}`);
    }
    const digest = String(asset.digest || '')
      .replace(/^sha256:/i, '')
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `La release no publica un digest SHA-256 válido para ${ASSET_NAME}; ` +
          'se rechaza la instalación por seguridad.',
      );
    }
    return {
      version: String(r.tag_name).replace(/^freebuff-v/i, ''),
      url: asset.browser_download_url,
      digest,
    };
  }

  /**
   * Instala o actualiza el binario con verificación de integridad y rollback:
   *   1. SHA-256 del tarball contra el digest publicado por GitHub.
   *   2. Cabecera ELF AARCH64 del binario extraído.
   *   3. Backup del binario anterior antes de reemplazarlo.
   *   4. Smoke test del binario nuevo; si falla, se restaura el anterior.
   *   5. Metadata escrito de forma atómica solo tras el smoke test.
   *   6. El shim se re-verifica al final (nunca lo invalida una actualización).
   */
  async function installOrUpdate({ force = false } = {}) {
    const current = readMeta();
    let rel;
    try {
      rel = await latest();
    } catch (e) {
      if (fsImpl.existsSync(config.binaryPath)) {
        console.error(
          `⚠️ No se pudo consultar la release (${e.message}). Se usará la versión instalada.`,
        );
        return current?.version || 'unknown';
      }
      throw e;
    }

    if (
      !force &&
      current?.version === rel.version &&
      fsImpl.existsSync(config.binaryPath)
    ) {
      return rel.version;
    }
    // Nunca degradar automáticamente una instalación que ya funciona.
    if (
      !force &&
      current?.version &&
      compareVersions(rel.version, current.version) < 0 &&
      fsImpl.existsSync(config.binaryPath)
    ) {
      console.error(
        `⚠️ La release ${rel.version} es anterior a la instalada (${current.version}). Se conserva la instalada.`,
      );
      return current.version;
    }

    const runnerCmd = io.runner();
    if (!runnerCmd) {
      throw die(
        'Falta glibc-runner. En Termux ejecuta: pkg install glibc-repo glibc-runner',
      );
    }

    fsImpl.rmSync(config.tempDir, { recursive: true, force: true });
    fsImpl.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
    const archive = path.join(config.tempDir, 'freebuff.tar.gz');
    let backupMade = false;
    let replaced = false;

    try {
      console.error(`⬇️  Descargando ${DISPLAY_NAME} ${rel.version} (Linux ARM64)...`);
      await io.download(rel.url, archive);

      const got = await io.sha256(archive);
      if (got !== rel.digest) {
        throw new Error(
          `SHA-256 no coincide. Esperado ${rel.digest}, obtenido ${got}. Se descarta la descarga.`,
        );
      }
      console.error(`🔒 SHA-256 verificado (${got.slice(0, 12)}…).`);

      const extractDir = path.join(config.tempDir, 'extract');
      fsImpl.mkdirSync(extractDir);
      await io.extract(archive, extractDir);

      const src = io.findBinary(extractDir);
      if (!src) {
        throw new Error('El archivo no contiene un ejecutable "freebuff"');
      }
      const machine = io.readElfMachine(src);
      if (machine === null) {
        throw new Error('El binario extraído no es un ELF válido; instalación rechazada.');
      }
      if (machine !== ELF_AARCH64) {
        throw new Error(
          `El binario extraído no es ARM64 (e_machine=${machine}, esperado ${ELF_AARCH64}); instalación rechazada.`,
        );
      }

      const staged = path.join(config.tempDir, PACKAGE);
      fsImpl.copyFileSync(src, staged);
      fsImpl.chmodSync(staged, 0o755);

      if (fsImpl.existsSync(config.binaryPath)) {
        fsImpl.copyFileSync(config.binaryPath, config.backupPath);
        backupMade = true;
      }
      fsImpl.renameSync(staged, config.binaryPath);
      replaced = true;

      if (!io.smokeTest(runnerCmd, config.binaryPath)) {
        throw new Error(
          'El binario recién instalado no arranca correctamente; se restaura la versión anterior.',
        );
      }

      writeMeta({
        version: rel.version,
        target: 'linux-arm64',
        sha256: got,
        binarySha256: await io.sha256(config.binaryPath),
        updatedAt: new Date().toISOString(),
        source: rel.url,
      });
      ensureBrokerShim();
      console.error(`✅ ${DISPLAY_NAME} ${rel.version} instalado.`);
      return rel.version;
    } catch (e) {
      if (replaced && backupMade && fsImpl.existsSync(config.backupPath)) {
        try {
          fsImpl.copyFileSync(config.backupPath, config.binaryPath);
          console.error('↩️  Versión anterior restaurada.');
        } catch (err) {
          console.error(`⚠️ No se pudo restaurar la versión anterior: ${err.message}`);
        }
      }
      throw e;
    } finally {
      if (backupMade) {
        try {
          fsImpl.rmSync(config.backupPath, { force: true });
        } catch {}
      }
      try {
        fsImpl.rmSync(config.tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  function doctorShimStatus() {
    let current = null;
    try {
      current = fsImpl.readFileSync(config.shimPath, 'utf8');
    } catch {}
    if (current === null) {
      return { ok: false, label: 'NO CREADO' };
    }
    if (current !== BROKER_SHIM_TEMPLATE) {
      return { ok: false, label: 'CONTENIDO OBSOLETO' };
    }
    if (!isExecutable(config.shimPath)) {
      return { ok: false, label: 'SIN PERMISO DE EJECUCIÓN' };
    }
    return { ok: true, label: 'OK' };
  }

  async function doctor() {
    console.log(`Android: ${isAndroid(env) ? 'sí' : 'no'}`);
    console.log(`Arquitectura: ${process.arch}`);
    console.log(`Termux PREFIX: ${env.PREFIX || '(no detectado)'}`);
    console.log(`Node: ${process.version}`);
    console.log(`Directorio de configuración: ${config.configDir}`);

    const runnerCmd = io.runner();
    console.log(`glibc-runner: ${runnerCmd || 'NO ENCONTRADO'}`);

    const binExists = fsImpl.existsSync(config.binaryPath);
    console.log(`Binario: ${binExists ? config.binaryPath : 'NO INSTALADO'}`);
    if (binExists) {
      const machine = io.readElfMachine(config.binaryPath);
      console.log(`  ELF: ${machine === ELF_AARCH64 ? 'ARM64 válido' : machine === null ? 'NO ES UN ELF' : `e_machine=${machine} (no ARM64)`}`);
      console.log(`  Ejecutable: ${isExecutable(config.binaryPath) ? 'sí' : 'no'}`);
      const meta = readMeta();
      if (meta?.binarySha256) {
        const now = await io.sha256(config.binaryPath);
        console.log(`  Integridad: ${now === meta.binarySha256 ? 'OK' : 'DIFIERE del instalado (¿modificado?)'}`);
      }
    }

    const meta = readMeta();
    console.log(`Versión: ${meta?.version || 'desconocida'}`);
    console.log(`Target: ${meta?.target || '(sin metadata)'}`);

    const shim = doctorShimStatus();
    console.log(`Broker shim: ${shim.ok ? shim.label : shim.label} → ${config.shimPath}`);

    if (!binExists) {
      console.log('\n➜ El binario no está instalado. Ejecuta: freebuff android-setup');
      return;
    }
    if (!runnerCmd) {
      console.log('\n➜ Falta glibc-runner: pkg install glibc-repo glibc-runner');
      return;
    }
    if (!shim.ok) {
      ensureBrokerShim();
      const after = doctorShimStatus();
      console.log(`\n➜ Shim reparado: ${after.label}`);
    }

    console.log('\nPrueba E2E mínima del broker (shim → grun → binario)...');
    const e2e = await io.brokerE2E(runnerCmd, config.binaryPath, config.shimPath, {
      config,
      env,
    });
    console.log(
      e2e.ok
        ? `✅ Broker E2E: ${e2e.detail}`
        : `❌ Broker E2E: ${e2e.detail}`,
    );
    if (!e2e.ok) {
      console.log(
        '   Si el binario es la release oficial sin compilar, puede que no incluya\n' +
          '   el parche FREEBUFF_ANDROID_BROKER_SHIM (ver patches/). El shim queda\n' +
          '   instalado igualmente y activará el broker cuando el binario lo soporte.',
      );
    }
  }

  function usage() {
    console.log(
      `${DISPLAY_NAME} Android/Termux (wrapper NO oficial v${WRAPPER_VERSION})\n` +
        '\n' +
        'Comandos:\n' +
        '  freebuff                 Ejecuta Freebuff (con el binario oficial Linux ARM64)\n' +
        '  freebuff --version       Muestra versión del wrapper y del binario\n' +
        '  freebuff android-setup   Comprueba/repara glibc-runner e instala\n' +
        '  freebuff android-update  Fuerza la actualización (con SHA-256 y rollback)\n' +
        '  freebuff android-doctor  Diagnóstico completo, shim y E2E mínimo del broker\n' +
        '  freebuff android-clean   Elimina la caché de descarga del launcher',
    );
  }

  async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    // Comandos de información/diagnóstico válidos en cualquier plataforma.
    if (command === '--help' || command === '-h' || command === 'help') {
      usage();
      return;
    }
    if (command === '--version' || command === '-v') {
      const m = readMeta();
      console.log(
        `freebuff ${m?.version || 'not installed'} (android wrapper ${WRAPPER_VERSION})`,
      );
      return;
    }
    if (command === 'android-doctor') {
      await doctor();
      return;
    }
    if (command === 'android-clean') {
      fsImpl.rmSync(config.tempDir, { recursive: true, force: true });
      console.log('Caché eliminada.');
      return;
    }

    // El resto (ejecutar, instalar, actualizar) exige Android/Termux ARM64.
    if (!isAndroid(env)) {
      throw die('Este wrapper está diseñado para Android/Termux.');
    }
    if (!isArm64()) {
      throw die(`Arquitectura no soportada: ${process.arch}. Solo ARM64.`);
    }

    const runnerCmd = io.runner();
    if (command === 'android-setup' || command === 'android-update') {
      if (!runnerCmd) {
        throw die('Falta glibc-runner. En Termux ejecuta: pkg install glibc-repo glibc-runner');
      }
      await installOrUpdate({ force: true });
      return;
    }

    if (!runnerCmd) {
      throw die('Falta glibc-runner. En Termux ejecuta: pkg install glibc-repo glibc-runner');
    }
    await installOrUpdate({ force: false });

    // Shim + variables de entorno para el broker (ver lib/broker-shim.sh y patches/).
    const shimPath = ensureBrokerShim();

    const resetTerminal = () => {
      try {
        if (process.stdout.isTTY) {
          // Secuencias seguras para dejar la terminal limpia si el binario
          // muere sin restaurar el estado (mouse, bracketed paste, cursor...).
          process.stdout.write(
            '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?25h',
          );
        }
      } catch {}
    };

    let child;
    const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    // Muere con la señal real (el shell ve 130 en Ctrl+C), tras quitar los
    // listeners para no entrar en bucle con process.kill(pid, sig).
    const dieWithSignal = (sig) => {
      try {
        for (const s of signalNames) process.removeAllListeners(s);
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
      setTimeout(() => process.exit(1), 100).unref();
    };

    const onSignal = (sig) => {
      resetTerminal();
      try {
        child?.kill(sig);
      } catch {}
      // Si la señal llega antes de que exista el hijo (p.ej. durante la
      // espera de red de installOrUpdate), salir ya.
      if (!child) return dieWithSignal(sig);
      // Si el binario ignora la señal (OpenTUI atrapa SIGTERM), escalar a
      // SIGKILL tras 1,5 s para no dejarlo huérfano agarrando la terminal.
      const killer = setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {}
      }, 1500);
      killer.unref?.();
      // Red de seguridad: si el hijo nunca emite 'exit', salir igualmente.
      const hardExit = setTimeout(() => dieWithSignal(sig), 5000);
      hardExit.unref?.();
    };
    for (const sig of signalNames) {
      process.on(sig, onSignal);
    }

    child = spawn(
      runnerCmd,
      [config.binaryPath, ...args],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          TERM: process.env.TERM || 'xterm-256color',
          FREEBUFF_ANDROID_BIN: config.binaryPath,
          FREEBUFF_ANDROID_GRUN: runnerCmd,
          FREEBUFF_ANDROID_BROKER_SHIM: shimPath,
        },
      },
    );

    child.on('error', (e) => {
      resetTerminal();
      die(`No se pudo iniciar ${DISPLAY_NAME}: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      resetTerminal();
      if (signal) {
        dieWithSignal(signal);
      } else {
        process.exit(code ?? 1);
      }
    });
  }

  return {
    config,
    io,
    main,
    doctor,
    latest,
    readMeta,
    writeMeta,
    ensureBrokerShim,
    installOrUpdate,
    isAndroid,
    isArm64,
    compareVersions,
    BROKER_SHIM_TEMPLATE,
  };
}

module.exports = {
  createWrapper,
  createConfig,
  defaultIo,
  BROKER_SHIM_TEMPLATE,
  WRAPPER_VERSION,
  compareVersions,
  ELF_AARCH64,
};

if (require.main === module) {
  const wrapper = createWrapper();
  wrapper.main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(e.exit || 1);
  });
}
