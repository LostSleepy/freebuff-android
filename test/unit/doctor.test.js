'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createWrapper,
  createConfig,
  defaultIo,
  BROKER_SHIM_TEMPLATE,
  ELF_AARCH64,
} = require('../../index.js');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

function fakeArm64Binary() {
  const buf = Buffer.alloc(128);
  ELF_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(ELF_AARCH64, 18);
  buf.write('doctor-binary', 32);
  return buf;
}

async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('doctor informa del estado del shim y ejecuta la E2E mínima', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doctor-'));
  try {
    const config = createConfig({ HOME: dir });
    const io = defaultIo({ env: { HOME: dir } });
    const wrapper = createWrapper({
      config,
      io: {
        ...io,
        runner: () => 'grun',
        brokerE2E: async () => ({ ok: true, detail: 'El broker respondió ok con exitCode 0' }),
      },
    });
    // Binario instalado + shim + metadata.
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, fakeArm64Binary(), { mode: 0o755 });
    wrapper.writeMeta({ version: '1.2.3', target: 'linux-arm64' });
    wrapper.ensureBrokerShim();

    const out = await captureLog(() => wrapper.doctor());
    assert.match(out, /glibc-runner: grun/);
    assert.match(out, /ELF: ARM64 válido/);
    assert.match(out, /Versión: 1\.2\.3/);
    assert.match(out, /Broker shim: OK/);
    assert.match(out, /Broker E2E.*El broker respondió ok/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor detecta shim ausente y lo repara', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doctor2-'));
  try {
    const config = createConfig({ HOME: dir });
    const io = defaultIo({ env: { HOME: dir } });
    const wrapper = createWrapper({
      config,
      io: {
        ...io,
        runner: () => 'grun',
        brokerE2E: async () => ({ ok: true, detail: 'ok' }),
      },
    });
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, fakeArm64Binary(), { mode: 0o755 });
    wrapper.writeMeta({ version: '1.2.3', target: 'linux-arm64' });
    // Shim corrupto a propósito.
    fs.writeFileSync(config.shimPath, 'echo roto');

    const out = await captureLog(() => wrapper.doctor());
    assert.match(out, /Broker shim: CONTENIDO OBSOLETO/);
    // Tras el doctor, el shim quedó reparado.
    assert.equal(fs.readFileSync(config.shimPath, 'utf8'), BROKER_SHIM_TEMPLATE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor avisa si no hay binario instalado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doctor3-'));
  try {
    const config = createConfig({ HOME: dir });
    const wrapper = createWrapper({
      config,
      io: { ...defaultIo({ env: { HOME: dir } }), runner: () => 'grun' },
    });
    const out = await captureLog(() => wrapper.doctor());
    assert.match(out, /NO INSTALADO/);
    assert.match(out, /freebuff android-setup/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
