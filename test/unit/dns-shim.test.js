'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createConfig, dnsShimSettings } = require('../../index.js');

/** Fake fs con existsSync controlado. */
function fakeFs(files) {
  return {
    existsSync: (p) => files.includes(p),
  };
}

const PREFIX = '/data/data/com.termux/files/usr';
const RESOLV_SRC = path.join(PREFIX, 'etc', 'resolv.conf');
const SHIM = '/somewhere/dns-redirect-aarch64.so';

function makeConfig() {
  return { ...createConfig({ HOME: '/home', PREFIX }), dnsShimPath: SHIM };
}

test('dnsShimSettings: null si FREEBUFF_ANDROID_NO_DNS_SHIM=1', () => {
  const config = makeConfig();
  const fsImpl = fakeFs(['/etc/resolv.conf', RESOLV_SRC, SHIM]);
  assert.equal(
    dnsShimSettings({ PREFIX, FREEBUFF_ANDROID_NO_DNS_SHIM: '1' }, config, fsImpl),
    null,
  );
});

test('dnsShimSettings: null sin PREFIX', () => {
  const config = makeConfig();
  const fsImpl = fakeFs(['/etc/resolv.conf', RESOLV_SRC, SHIM]);
  assert.equal(dnsShimSettings({}, config, fsImpl), null);
});

test('dnsShimSettings: null si /etc/resolv.conf existe (Linux normal)', () => {
  const config = makeConfig();
  const fsImpl = fakeFs(['/etc/resolv.conf', RESOLV_SRC, SHIM]);
  assert.equal(dnsShimSettings({ PREFIX }, config, fsImpl), null);
});

test('dnsShimSettings: null si falta el resolv.conf origen', () => {
  const config = makeConfig();
  const fsImpl = fakeFs([SHIM]);
  assert.equal(dnsShimSettings({ PREFIX }, config, fsImpl), null);
});

test('dnsShimSettings: null si falta el .so del shim', () => {
  const config = makeConfig();
  const fsImpl = fakeFs([RESOLV_SRC]);
  assert.equal(dnsShimSettings({ PREFIX }, config, fsImpl), null);
});

test('dnsShimSettings: activo en Android con todo presente', () => {
  const config = makeConfig();
  const fsImpl = fakeFs([RESOLV_SRC, SHIM]);
  const result = dnsShimSettings({ PREFIX, HOME: '/home' }, config, fsImpl);
  assert.deepEqual(result, { shim: SHIM, resolvConf: RESOLV_SRC });
});