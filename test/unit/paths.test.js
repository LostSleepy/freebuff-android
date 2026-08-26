'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createWrapper,
  createConfig,
  defaultIo,
  BROKER_SHIM_TEMPLATE,
  WRAPPER_VERSION,
} = require('../../index.js');

test('createConfig deriva todas las rutas de $HOME (sin rutas hardcodeadas)', () => {
  const home = '/data/data/com.termux/files/home';
  const config = createConfig({ HOME: home });
  assert.equal(config.configDir, path.join(home, '.config', 'manicode'));
  for (const p of [
    config.configDir,
    config.binaryPath,
    config.metadataPath,
    config.tempDir,
    config.shimPath,
    config.backupPath,
  ]) {
    assert.ok(p.startsWith(home), `${p} debe colgar de $HOME`);
    assert.ok(!p.includes('/tmp'), `${p} no debe usar /tmp`);
  }
  // El único literal /data/data/... es el de DETECCIÓN, no de escritura.
  assert.equal(config.termuxUsrPrefix, '/data/data/com.termux/files/usr');
});

test('createConfig usa os.homedir() cuando falta $HOME', () => {
  const config = createConfig({});
  assert.equal(typeof config.home, 'string');
  assert.ok(config.home.length > 0);
});

test('isAndroid detecta Termux por PREFIX, TERMUX_VERSION o getprop', () => {
  const wrapper = createWrapper({ config: createConfig({ HOME: '/tmp/x' }) });
  assert.equal(
    wrapper.isAndroid({ PREFIX: '/data/data/com.termux/files/usr' }, {
      existsSync: () => false,
    }),
    true,
  );
  assert.equal(
    wrapper.isAndroid({ TERMUX_VERSION: '0.118.0' }, { existsSync: () => false }),
    true,
  );
  assert.equal(wrapper.isAndroid({}, { existsSync: () => true }), true);
  assert.equal(wrapper.isAndroid({}, { existsSync: () => false }), false);
});

test('el módulo exporta la API de testeo y el template del shim', () => {
  assert.equal(typeof createWrapper, 'function');
  assert.equal(typeof createConfig, 'function');
  assert.equal(typeof defaultIo, 'function');
  assert.match(BROKER_SHIM_TEMPLATE, /# freebuff-broker-shim/);
  assert.equal(typeof WRAPPER_VERSION, 'string');
});
