'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { termuxPrefix, pathWithBin } = require('../../index.js');

/** Fake fs con existsSync controlado. */
function fakeFs(files) {
  return {
    existsSync: (p) => files.includes(p),
  };
}

test('termuxPrefix usa $PREFIX exportado tal cual (sin consultar el fs)', () => {
  const prefix = '/data/data/com.termux/files/usr';
  const env = {
    PREFIX: prefix,
    HOME: '/data/data/com.termux/files/home',
  };
  // Si el valor exportado manda, no debe hacer falta tocar el filesystem.
  const fsImpl = {
    existsSync: () => {
      throw new Error('no debe consultar el fs cuando $PREFIX está exportado');
    },
  };
  assert.equal(termuxPrefix(env, fsImpl), prefix);
});

test('termuxPrefix deriva el PREFIX de $HOME cuando falta $PREFIX', () => {
  // Layout real de Termux: $HOME es hermano de <prefix>/usr
  // (/data/data/com.termux/files/home), así que prefijo = $HOME/../usr.
  const prefix = '/data/data/com.termux/files/usr';
  const env = { HOME: path.join(path.dirname(prefix), 'home') }; // sin PREFIX
  const fsImpl = fakeFs([path.join(prefix, 'bin')]);
  assert.equal(termuxPrefix(env, fsImpl), prefix);
});

test('termuxPrefix devuelve null si la derivación no existe en disco', () => {
  const env = { HOME: '/data/data/com.termux/files/home' };
  const fsImpl = fakeFs([]);
  assert.equal(termuxPrefix(env, fsImpl), null);
});

test('termuxPrefix usa el homedir (inyectable) cuando faltan HOME y PREFIX', () => {
  // Sin HOME ni PREFIX cae a os.homedir(); aquí se inyecta para que el test
  // no dependa del entorno (en Termux os.homedir() ES el home de Termux).
  const fsImpl = fakeFs(['/x/usr/bin']);
  assert.equal(termuxPrefix({}, fsImpl, () => '/x/home'), '/x/usr');
});

test('termuxPrefix devuelve null si ni HOME ni homedir apuntan a un prefijo válido', () => {
  assert.equal(termuxPrefix({}, { existsSync: () => false }, () => '/x/home'), null);
  assert.equal(termuxPrefix({}, fakeFs([]), () => ''), null);
});

test('pathWithBin antepone el binario al PATH', () => {
  assert.equal(
    pathWithBin('/system/bin:/vendor/bin', '/data/data/com.termux/files/usr/bin'),
    '/data/data/com.termux/files/usr/bin:/system/bin:/vendor/bin',
  );
});

test('pathWithBin no duplica si el binario ya está en el PATH', () => {
  const p = '/data/data/com.termux/files/usr/bin:/system/bin';
  assert.equal(pathWithBin(p, '/data/data/com.termux/files/usr/bin'), p);
});

test('pathWithBin mantiene el comportamiento previo con PATH vacío/undefined', () => {
  assert.equal(pathWithBin('', '/usr/bin'), '/usr/bin:');
  assert.equal(pathWithBin(undefined, '/usr/bin'), '/usr/bin:');
});

test('pathWithBin no toca el PATH si el binario es null o vacío', () => {
  const p = '/system/bin';
  assert.equal(pathWithBin(p, null), p);
  assert.equal(pathWithBin(p, ''), p);
});
