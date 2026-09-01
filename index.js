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

const WRAPPER_VERSION = '0.5.0';
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
 * Resuelve de forma robusta el PREFIX de Termux, sin hardcodear la ruta:
 *
 * 1. Si $PREFIX está exportado, se usa tal cual (fuente fiable).
 * 2. Si no (sesión lanzada por una app/servicio/tmux con entorno mínimo), se
 *    deriva de $HOME: en Termux $HOME es <prefix>/home, así que el prefijo es
 *    $HOME/../usr. Solo se acepta si <candidato>/bin existe de verdad (nunca
 *    se escribe ni se asume una ruta fija).
 *
 * Devuelve null si no se puede determinar (Linux normal, Android sin Termux).
 */
function termuxPrefix(env = process.env, fsImpl = fs, homedirFn = os.homedir) {
  if (env.PREFIX) return env.PREFIX;
  const home = env.HOME || homedirFn();
  if (!home) return null;
  const candidate = path.join(home, '..', 'usr');
  return fsImpl.existsSync(path.join(candidate, 'bin')) ? candidate : null;
}

/**
 * Antepone `bin` a un PATH (string separado por ':') si no está ya incluido.
 * Devuelve el PATH original si `bin` es null/'' o ya está presente (nunca
 * duplica entradas). Mantiene exactamente el comportamiento previo para PATH
 * vacío/undefined (añade ':' final, como hacía el launcher desde v0.4.0).
 */
function pathWithBin(pathValue, bin) {
  if (!bin) return pathValue;
  const entries = (pathValue || '').split(':').filter(Boolean);
  if (entries.includes(bin)) return pathValue;
  return pathValue ? `${bin}:${pathValue}` : `${bin}:`;
}

/**
 * Decide si inyectar el shim DNS (dns-redirect-aarch64.so) al lanzar el
 * binario. El resolver interno de Bun (c-ares) lee literalmente
 * /etc/resolv.conf, un archivo que NO existe en Android (solo root podría
 * crearlo), así que cae a 127.0.0.1:53 y toda resolución muere con
 * "getaddrinfo ETIMEOUT" (read_url, etc.). El shim redirige ese path al
 * resolv.conf de glibc-runner ($PREFIX/etc/resolv.conf), que sí tiene servidores
 * alcanzables por UDP directo.
 *
 * Se desactiva con FREEBUFF_ANDROID_NO_DNS_SHIM=1, y no aplica en Linux
 * normal (donde /etc/resolv.conf existe). Solo funciona en ejecución directa:
 * grun elimina LD_PRELOAD, así que en modo grun el shim no se cargaría.
 *
 * Devuelve { shim, resolvConf } o null.
 */
function dnsShimSettings(env = process.env, config = createConfig(env), fsImpl = fs) {
  if (env.FREEBUFF_ANDROID_NO_DNS_SHIM) return null;
  const prefix = env.PREFIX;
  if (!prefix) return null;
  // Linux/PC normal ya tiene /etc/resolv.conf → no hace falta.
  if (fsImpl.existsSync('/etc/resolv.conf')) return null;
  const resolvConf = path.join(prefix, 'etc', 'resolv.conf');
  if (!fsImpl.existsSync(resolvConf)) return null;
  if (!fsImpl.existsSync(config.dnsShimPath)) return null;
  return { shim: config.dnsShimPath, resolvConf };
}

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
    // patchelf aarch64 empaquetado en el paquete npm (lib/patchelf-aarch64).
    patchelfPath: path.join(__dirname, 'lib', 'patchelf-aarch64'),
    // Shim DNS aarch64 (lib/dns-redirect-aarch64.so): redirige /etc/resolv.conf
    // al resolv.conf de glibc-runner para que el resolver de Bun (c-ares) funcione.
    dnsShimPath: path.join(__dirname, 'lib', 'dns-redirect-aarch64.so'),
    // Directorio de librerías glibc de glibc-runner, derivado de $PREFIX.
    glibcPrefix: env.PREFIX ? path.join(env.PREFIX, 'glibc') : null,
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

/**
 * Entorno para ejecutar el binario DIRECTO: LD_PRELOAD y LD_LIBRARY_PATH
 * fuera. LD_PRELOAD (libtermux-exec-ld-preload.so) rompe la resolución de
 * librerías del loader glibc cuando se invoca por PT_INTERP, y LD_LIBRARY_PATH
 * no hace falta (el loader usa su ruta de sistema). grun hace lo mismo.
 */
function sanitizeEnv(env) {
  const clean = { ...env };
  delete clean.LD_PRELOAD;
  delete clean.LD_LIBRARY_PATH;
  return clean;
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
  config = createConfig(env),
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
     * Lee el intérprete (PT_INTERP) declarado por el ELF. null si no es ELF
     * o no se pudo leer. Se parsean los program headers a mano (sin readelf).
     */
    readElfInterp(file) {
      try {
        const buf = fsImpl.readFileSync(file);
        if (
          buf.length < 64 ||
          !buf.subarray(0, 4).equals(ELF_MAGIC)
        ) {
          return null;
        }
        const phoff = Number(buf.readBigUInt64LE(32));
        const phentsize = buf.readUInt16LE(54);
        const phnum = buf.readUInt16LE(56);
        for (let i = 0; i < phnum; i++) {
          const off = phoff + i * phentsize;
          const type = buf.readUInt32LE(off);
          if (type === 3) {
            // PT_INTERP
            const pOffset = Number(buf.readBigUInt64LE(off + 8));
            const pFilesz = Number(buf.readBigUInt64LE(off + 32));
            return buf
              .subarray(pOffset, pOffset + pFilesz)
              .toString('utf8')
              .replace(/\0+$/, '');
          }
        }
        return null;
      } catch {
        return null;
      }
    },

    /**
     * Localiza el loader glibc de glibc-runner (derivado de $PREFIX).
     */
    findLoader(config) {
      if (!config.glibcPrefix) return null;
      const candidates = [
        path.join(config.glibcPrefix, 'lib', 'ld-linux-aarch64.so.1'),
        path.join(config.glibcPrefix, 'lib', 'ld-linux-aarch64.so.2'),
        path.join(config.glibcPrefix, 'bin', 'ld.so'),
      ];
      return candidates.find((c) => fsImpl.existsSync(c)) || null;
    },

    /**
     * Reescribe el intérprete del binario con el patchelf empaquetado.
     * Devuelve true si patchelf terminó con status 0.
     */
    patchelfInterp(bin, interp) {
      const r = spawnSyncFn(config.patchelfPath, ['--set-interpreter', interp, bin], {
        stdio: 'ignore',
        timeout: 60000,
      });
      return !r.error && r.status === 0;
    },

    /**
     * Smoke test del binario ejecutado DIRECTO (sin grun) con el entorno
     * saneado (LD_PRELOAD fuera). Exige que arranque y que --version devuelva
     * algo con forma de versión (p.ej. 0.0.156).
     */
    directSmokeTest(bin) {
      let r;
      try {
        r = spawnSyncFn(bin, ['--version'], {
          timeout: 20000,
          encoding: 'utf8',
          env: sanitizeEnv(env),
        });
      } catch {
        return false;
      }
      if (r.error) return r.error.code === 'ETIMEDOUT';
      if (r.signal && !['SIGKILL', 'SIGTERM'].includes(r.signal)) return false;
      return r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout || '');
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
     * E2E mínimo del broker en modo DIRECTO (usado por android-doctor cuando
     * el binario está preparado para ejecución directa): arranca el binario
     * directamente con el flag de broker (sin grun ni shim) y comprueba que
     * responde por el archivo de protocolo. Devuelve { ok, detail }.
     */
    brokerDirectE2E(bin, { config, env: envArg = env } = {}) {
      const protocolFile = path.join(
        tmpdirFn(),
        `freebuff-terminal-command-broker-${process.pid}-${crypto.randomUUID()}.json`,
      );
      const request = {
        executable: '/bin/sh',
        args: ['-c', 'printf broker-directo-ok; exit 0'],
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
          child = spawnFn(bin, ['--terminal-command-broker'], {
            stdio: ['pipe', 'inherit', 'inherit'],
            env: sanitizeEnv({
              ...envArg,
              CODEBUFF_TERMINAL_COMMAND_BROKER: '1',
              CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL: protocolFile,
            }),
          });
        } catch (e) {
          return finish(false, `No se pudo lanzar el binario: ${e.message}`);
        }
        child.on('error', (e) => finish(false, `Error al lanzar el binario: ${e.message}`));
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(request));

        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          finish(false, 'Timeout esperando la respuesta del broker');
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
  io = defaultIo({ env, config }),
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

      const prepared = await prepareDirectRun();
      writeMeta({
        version: rel.version,
        target: 'linux-arm64',
        sha256: got,
        binarySha256: await io.sha256(config.binaryPath),
        directRun: prepared.mode === 'direct',
        updatedAt: new Date().toISOString(),
        source: rel.url,
      });
      ensureBrokerShim();
      console.error(
        `✅ ${DISPLAY_NAME} ${rel.version} instalado.` +
          (prepared.mode === 'direct'
            ? ' (ejecución directa, broker OK)'
            : ' (modo grun; broker no disponible)'),
      );
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

  /**
   * Prepara el binario para EJECUCIÓN DIRECTA (sin grun): reescribe el
   * intérprete ELF (PT_INTERP) al loader glibc real con el patchelf
   * empaquetado, de modo que process.execPath apunte al binario y el terminal
   * command broker funcione con el binario oficial sin parchear.
   *
   * Idempotente: si el intérprete ya es el correcto, solo verifica con un
   * smoke test directo. Devuelve { mode: 'direct' | 'grun', loader, interp }.
   */
  async function prepareDirectRun() {
    if (!fsImpl.existsSync(config.binaryPath)) {
      return { mode: 'grun', loader: null, interp: null };
    }
    const loader = io.findLoader(config);
    if (!loader) {
      console.error(
        '⚠️ No se encontró el loader glibc; se usará modo grun (broker no disponible).',
      );
      return { mode: 'grun', loader: null, interp: null };
    }

    const current = io.readElfInterp(config.binaryPath);
    if (current === loader) {
      return {
        mode: io.directSmokeTest(config.binaryPath) ? 'direct' : 'grun',
        loader,
        interp: current,
      };
    }

    // Reescribir el intérprete sobre una copia y verificar antes de reemplazar
    // (evita dejar un binario roto si patchelf falla, como con --set-rpath).
    const tmp = path.join(config.tempDir, `${PACKAGE}.direct`);
    fsImpl.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      fsImpl.copyFileSync(config.binaryPath, tmp);
      fsImpl.chmodSync(tmp, 0o755);
      if (!io.patchelfInterp(tmp, loader)) {
        console.error('⚠️ patchelf falló al reescribir el intérprete; se usará modo grun.');
        return { mode: 'grun', loader, interp: current };
      }
      if (!io.directSmokeTest(tmp)) {
        console.error(
          '⚠️ El binario reescrito no arranca en modo directo; se usará modo grun.',
        );
        return { mode: 'grun', loader, interp: current };
      }
      fsImpl.renameSync(tmp, config.binaryPath);
      console.error('⚙️  Ejecución directa preparada (intérprete glibc + LD_PRELOAD fuera).');
      return { mode: 'direct', loader, interp: loader };
    } finally {
      try {
        fsImpl.rmSync(tmp, { force: true });
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

    // Estado de ejecución: directa (broker OK) o grun (broker no disponible).
    if (binExists) {
      const loader = io.findLoader(config);
      const interp = io.readElfInterp(config.binaryPath);
      const direct = meta?.directRun === true && interp === loader;
      console.log(`Ejecución: ${direct ? 'DIRECTA (sin grun, broker OK)' : 'vía grun (broker no disponible)'}`);
      console.log(`  Intérprete ELF: ${interp || '(no legible)'}`);
      console.log(`  Loader glibc: ${loader || 'NO ENCONTRADO'}`);
    }

    const shim = doctorShimStatus();
    console.log(`Broker shim: ${shim.ok ? shim.label : shim.label} → ${config.shimPath}`);

    const dnsShim = dnsShimSettings(env, config, fsImpl);
    console.log(
      `Shim DNS: ${dnsShim ? `ACTIVO → ${dnsShim.shim}` : 'inactivo (no necesario o desactivado)'}`,
    );

    if (!binExists) {
      console.log('\n➜ El binario no está instalado. Ejecuta: freebuff android-setup');
      return;
    }

    const direct = meta?.directRun === true && io.readElfInterp(config.binaryPath) === io.findLoader(config);
    if (direct && !runnerCmd) {
      // La ejecución directa no necesita grun para el binario, pero sí para
      // el shim. Se avisa pero no se bloquea.
      console.log('\n➜ glibc-runner no está en PATH (solo afecta al shim de respaldo).');
    } else if (!direct && !runnerCmd) {
      console.log('\n➜ Falta glibc-runner: pkg install glibc-repo glibc-runner');
      return;
    }
    if (!shim.ok) {
      ensureBrokerShim();
      const after = doctorShimStatus();
      console.log(`\n➜ Shim reparado: ${after.label}`);
    }

    console.log('\nPrueba E2E mínima del broker...');
    const e2e = direct
      ? await io.brokerDirectE2E(config.binaryPath, { config, env })
      : await io.brokerE2E(runnerCmd, config.binaryPath, config.shimPath, {
          config,
          env,
        });
    console.log(
      e2e.ok
        ? `✅ Broker E2E (${direct ? 'directa' : 'vía shim/grun'}): ${e2e.detail}`
        : `❌ Broker E2E: ${e2e.detail}`,
    );
    if (!e2e.ok && !direct) {
      console.log(
        '   El broker vía grun requiere el parche FREEBUFF_ANDROID_BROKER_SHIM\n' +
          '   (ver patches/) o la ejecución directa (android-update la prepara).',
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

    // Preparar ejecución directa (patchelf interp) si no está ya hecha.
    const prepared = await prepareDirectRun();
    const directRun =
      prepared.mode === 'direct' &&
      io.readElfInterp(config.binaryPath) === io.findLoader(config);
    if (directRun) {
      // Mantener la metadata coherente si la preparación cambió algo.
      const m = readMeta();
      if (m && m.directRun !== true) {
        writeMeta({
          ...m,
          directRun: true,
          binarySha256: await io.sha256(config.binaryPath),
        });
      }
    }

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

    // Termux NO está en el PATH del sistema Android. Si la sesión se lanzó
    // con un PATH mínimo (app/servicio/tmux/zsh con entorno limpio), el broker
    // (o el shim) no encuentra "bash" ni "grun" por PATH y falla con
    // "Executable not found in $PATH: bash". Para que esto sea robusto venga
    // de donde venga el lanzamiento, resolvemos el PREFIX de forma fiable
    // ($PREFIX exportado, o derivado de $HOME con verificación en disco) y
    // aseguramos $PREFIX/bin al principio del PATH del hijo (sin duplicarlo);
    // así el binario y todo lo que su broker ejecute (bash, git, grun, ...)
    // resuelven los ejecutables de Termux.
    const termuxPrefixValue = termuxPrefix(env, fsImpl);
    const termuxBin = termuxPrefixValue
      ? path.join(termuxPrefixValue, 'bin')
      : null;
    const baseEnv = {
      ...process.env,
      // Si hubo que derivar el prefijo, exponerlo también en el hijo (y en el
      // shim DNS, ver más abajo) en lugar de dejarlo ausente.
      ...(termuxPrefixValue ? { PREFIX: termuxPrefixValue } : {}),
      PATH: pathWithBin(process.env.PATH, termuxBin),
      TERM: process.env.TERM || 'xterm-256color',
      FREEBUFF_ANDROID_BIN: config.binaryPath,
      FREEBUFF_ANDROID_GRUN: runnerCmd,
      FREEBUFF_ANDROID_BROKER_SHIM: shimPath,
    };
    // Shim DNS (solo ejecución directa): LD_PRELOAD se elimina en sanitizeEnv
    // (libtermux-exec rompe el loader glibc), así que lo añadimos EXPRESAMENTE
    // después. En modo grun no aplica (grun quita LD_PRELOAD por diseño). Se
    // le pasa el entorno con el PREFIX ya resuelto para que el shim tampoco se
    // desactive cuando la sesión no exportó $PREFIX (el mismo hueco que el
    // PATH del broker).
    const dnsShim = dnsShimSettings(
      termuxPrefixValue
        ? { ...process.env, PREFIX: termuxPrefixValue }
        : process.env,
      config,
      fsImpl,
    );
    const directEnv = sanitizeEnv(baseEnv);
    if (dnsShim) {
      directEnv.LD_PRELOAD = dnsShim.shim;
      directEnv.FREEBUFF_RESOLV_CONF = dnsShim.resolvConf;
    }

    child = directRun
      ? // Ejecución directa: process.execPath = binario → el broker se
        // re-ejecuta solo. LD_PRELOAD/LD_LIBRARY_PATH fuera (ver sanitizeEnv),
        // salvo el shim DNS añadido arriba (ver dnsShimSettings).
        spawn(config.binaryPath, args, {
          stdio: 'inherit',
          env: directEnv,
        })
      : // Respaldo: vía grun (la TUI funciona; el broker requiere parche/shims).
        spawn(runnerCmd, [config.binaryPath, ...args], {
          stdio: 'inherit',
          env: baseEnv,
        });

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
    prepareDirectRun,
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
  dnsShimSettings,
  termuxPrefix,
  pathWithBin,
  BROKER_SHIM_TEMPLATE,
  WRAPPER_VERSION,
  compareVersions,
  ELF_AARCH64,
  sanitizeEnv,
};

if (require.main === module) {
  const wrapper = createWrapper();
  wrapper.main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(e.exit || 1);
  });
}
