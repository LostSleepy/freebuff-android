'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createWrapper,
  createConfig,
  BROKER_SHIM_TEMPLATE,
} = require('../../index.js');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-shim-test-'));
  const config = createConfig({ HOME: dir });
  return { dir, config };
}

test('lib/broker-shim.sh coincide byte a byte con BROKER_SHIM_TEMPLATE', () => {
  const file = path.join(__dirname, '..', '..', 'lib', 'broker-shim.sh');
  assert.equal(fs.readFileSync(file, 'utf8'), BROKER_SHIM_TEMPLATE);
});

test('ensureBrokerShim crea el shim ejecutable con el contenido canónico', () => {
  const { dir, config } = tempConfig();
  try {
    const wrapper = createWrapper({ config });
    const shimPath = wrapper.ensureBrokerShim();
    assert.equal(shimPath, config.shimPath);
    assert.equal(fs.readFileSync(config.shimPath, 'utf8'), BROKER_SHIM_TEMPLATE);
    const mode = fs.statSync(config.shimPath).mode;
    assert.ok(mode & 0o111, 'debe tener permiso de ejecución');
    fs.accessSync(config.shimPath, fs.constants.X_OK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrokerShim repara un shim truncado u obsoleto', () => {
  const { dir, config } = tempConfig();
  try {
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.shimPath, '#!/bin/bash\necho roto\n', { mode: 0o644 });
    const wrapper = createWrapper({ config });
    wrapper.ensureBrokerShim();
    assert.equal(fs.readFileSync(config.shimPath, 'utf8'), BROKER_SHIM_TEMPLATE);
    fs.accessSync(config.shimPath, fs.constants.X_OK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrokerShim no reescribe un shim válido (no toca el mtime)', () => {
  const { dir, config } = tempConfig();
  try {
    const wrapper = createWrapper({ config });
    wrapper.ensureBrokerShim();
    const before = fs.statSync(config.shimPath).mtimeMs;
    wrapper.ensureBrokerShim();
    const after = fs.statSync(config.shimPath).mtimeMs;
    assert.equal(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una actualización no elimina ni invalida el shim', () => {
  const { dir, config } = tempConfig();
  try {
    const wrapper = createWrapper({ config });
    wrapper.ensureBrokerShim();
    const before = fs.readFileSync(config.shimPath, 'utf8');
    // Simula el ciclo de update: instala (que re-verifica el shim al final).
    fs.writeFileSync(config.binaryPath, Buffer.from('binary'), { mode: 0o755 });
    wrapper.ensureBrokerShim();
    assert.equal(fs.readFileSync(config.shimPath, 'utf8'), before);
    fs.accessSync(config.shimPath, fs.constants.X_OK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
