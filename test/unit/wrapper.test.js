'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tar = require('tar');

const {
  createWrapper,
  createConfig,
  defaultIo,
  compareVersions,
  ELF_AARCH64,
} = require('../../index.js');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

function fakeArm64Binary() {
  const buf = Buffer.alloc(256);
  ELF_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(ELF_AARCH64, 18); // e_machine = AARCH64
  buf.write('fake-freebuff-binary', 64);
  return buf;
}

async function makeReleaseTarball(dir, binaryBuffer) {
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'freebuff'), binaryBuffer, {
    mode: 0o755,
  });
  const archive = path.join(dir, 'release.tar.gz');
  await tar.c({ gzip: true, cwd: contentDir, file: archive }, ['freebuff']);
  return archive;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Crea un wrapper con red/extracción simuladas pero SHA-256, tar y ELF reales.
 * `release` permite configurar la respuesta de getJson por test.
 */
function makeWrapper({ dir, release, smokeOk = true, onDownload }) {
  const config = createConfig({ HOME: dir });
  const io = defaultIo({ env: { HOME: dir } });
  return {
    config,
    wrapper: createWrapper({
      config,
      io: {
        ...io,
        runner: () => 'grun',
        getJson: async () => release,
        download: async (url, dest) => {
          if (onDownload) onDownload(url, dest);
          fs.copyFileSync(release._archive, dest);
        },
        extract: (archive, destDir) => tar.x({ file: archive, cwd: destDir }),
        smokeTest: () => smokeOk,
      },
    }),
  };
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `freebuff-${name}-`));
}

test('instala la release oficial verificando SHA-256, ELF ARM64 y metadata', async () => {
  const dir = tempDir('install');
  try {
    const binary = fakeArm64Binary();
    const archive = await makeReleaseTarball(dir, binary);
    const digest = sha256Hex(fs.readFileSync(archive));
    const { config, wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v9.9.9',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${digest}`,
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
        _archive: archive,
      },
    });

    const version = await wrapper.installOrUpdate({});
    assert.equal(version, '9.9.9');
    assert.ok(fs.existsSync(config.binaryPath));
    const meta = wrapper.readMeta();
    assert.equal(meta.version, '9.9.9');
    assert.equal(meta.target, 'linux-arm64');
    assert.equal(meta.sha256, digest);
    assert.equal(meta.binarySha256, sha256Hex(binary));
    // No queda caché ni backup.
    assert.ok(!fs.existsSync(config.tempDir));
    assert.ok(!fs.existsSync(config.backupPath));
    // El shim se aseguró tras la instalación.
    assert.ok(fs.existsSync(config.shimPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rechaza la instalación si el digest SHA-256 no coincide', async () => {
  const dir = tempDir('badsha');
  try {
    const archive = await makeReleaseTarball(dir, fakeArm64Binary());
    const { config, wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v1.0.0',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${'0'.repeat(64)}`, // falso
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
        _archive: archive,
      },
    });
    await assert.rejects(() => wrapper.installOrUpdate({}), /SHA-256 no coincide/);
    assert.ok(!fs.existsSync(config.binaryPath));
    assert.ok(!fs.existsSync(config.tempDir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rechaza la instalación si la release no publica digest', async () => {
  const dir = tempDir('nodigest');
  try {
    const { wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v1.0.0',
        assets: [{ name: 'freebuff-linux-arm64.tar.gz' }], // sin digest
      },
    });
    await assert.rejects(
      () => wrapper.installOrUpdate({}),
      /no publica un digest SHA-256 válido/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rechaza un binario extraído que no es ELF ARM64', async () => {
  const dir = tempDir('notelf');
  try {
    // Tarball con un "freebuff" que no es ELF.
    const contentDir = path.join(dir, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'freebuff'), 'not-an-elf');
    const archive = path.join(dir, 'release.tar.gz');
    await tar.c({ gzip: true, cwd: contentDir, file: archive }, ['freebuff']);

    const { config, wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v1.0.0',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${sha256Hex(fs.readFileSync(archive))}`,
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
        _archive: archive,
      },
    });
    await assert.rejects(() => wrapper.installOrUpdate({}), /no es un ELF/);
    assert.ok(!fs.existsSync(config.binaryPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hace rollback si el smoke test del binario nuevo falla', async () => {
  const dir = tempDir('rollback');
  try {
    const oldBinary = fakeArm64Binary();
    oldBinary.write('OLD', 64);
    const oldArchive = await makeReleaseTarball(dir, oldBinary);
    const newBinary = fakeArm64Binary();
    newBinary.write('NEW', 64);
    const newArchive = await makeReleaseTarball(dir, newBinary);

    const digest = (p) => sha256Hex(fs.readFileSync(p));
    const { config, wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v2.0.0',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${digest(newArchive)}`,
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
        _archive: newArchive,
        _old: oldArchive,
      },
    });
    // Instala la versión vieja con smoke OK.
    wrapper.io.getJson = async () => ({
      tag_name: 'freebuff-v1.0.0',
      assets: [
        {
          name: 'freebuff-linux-arm64.tar.gz',
          digest: `sha256:${digest(oldArchive)}`,
          browser_download_url: 'https://example.com/old.tar.gz',
        },
      ],
      _archive: oldArchive,
    });
    wrapper.io.download = async (url, dest) => {
      fs.copyFileSync(
        url.endsWith('old.tar.gz') ? oldArchive : newArchive,
        dest,
      );
    };
    wrapper.io.smokeTest = () => true;
    await wrapper.installOrUpdate({});
    const oldBytes = fs.readFileSync(config.binaryPath);

    // Ahora la release nueva falla el smoke test → rollback.
    wrapper.io.getJson = async () => ({
      tag_name: 'freebuff-v2.0.0',
      assets: [
        {
          name: 'freebuff-linux-arm64.tar.gz',
          digest: `sha256:${digest(newArchive)}`,
          browser_download_url: 'https://example.com/new.tar.gz',
        },
      ],
    });
    wrapper.io.smokeTest = () => false;
    await assert.rejects(
      () => wrapper.installOrUpdate({ force: true }),
      /se restaura la versión anterior/,
    );
    // El binario vuelve a ser el viejo y el metadata sigue en v1.0.0.
    assert.deepEqual(fs.readFileSync(config.binaryPath), oldBytes);
    assert.equal(wrapper.readMeta().version, '1.0.0');
    assert.ok(!fs.existsSync(config.backupPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nunca degrada automáticamente una instalación que funciona', async () => {
  const dir = tempDir('nodowngrade');
  try {
    const { wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v1.0.0',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${'a'.repeat(64)}`,
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
      },
    });
    fs.mkdirSync(wrapper.config.configDir, { recursive: true });
    fs.writeFileSync(wrapper.config.binaryPath, 'installed');
    wrapper.writeMeta({ version: '9.9.9', target: 'linux-arm64' });
    let downloads = 0;
    wrapper.io.download = async () => {
      downloads++;
    };
    const version = await wrapper.installOrUpdate({});
    assert.equal(version, '9.9.9');
    assert.equal(downloads, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('si no puede consultar la release, conserva la instalada', async () => {
  const dir = tempDir('offline');
  try {
    const { wrapper } = makeWrapper({
      dir,
      release: null,
    });
    fs.mkdirSync(wrapper.config.configDir, { recursive: true });
    fs.writeFileSync(wrapper.config.binaryPath, 'installed');
    wrapper.writeMeta({ version: '3.3.3', target: 'linux-arm64' });
    wrapper.io.getJson = async () => {
      throw new Error('sin red');
    };
    const version = await wrapper.installOrUpdate({});
    assert.equal(version, '3.3.3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('instala de nuevo si el binario falta aunque la versión coincida', async () => {
  const dir = tempDir('reinstall');
  try {
    const binary = fakeArm64Binary();
    const archive = await makeReleaseTarball(dir, binary);
    const digest = sha256Hex(fs.readFileSync(archive));
    const { wrapper } = makeWrapper({
      dir,
      release: {
        tag_name: 'freebuff-v5.5.5',
        assets: [
          {
            name: 'freebuff-linux-arm64.tar.gz',
            digest: `sha256:${digest}`,
            browser_download_url: 'https://example.com/release.tar.gz',
          },
        ],
        _archive: archive,
      },
    });
    fs.mkdirSync(wrapper.config.configDir, { recursive: true });
    wrapper.writeMeta({ version: '5.5.5', target: 'linux-arm64' });
    // Metadata dice 5.5.5 pero el binario no existe → debe instalar.
    const version = await wrapper.installOrUpdate({});
    assert.equal(version, '5.5.5');
    assert.ok(fs.existsSync(wrapper.config.binaryPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.2.3'), 1);
  assert.equal(compareVersions('0.0.156', '0.0.2'), 1);
  assert.equal(compareVersions('0.0.2', '0.0.156'), -1);
});
