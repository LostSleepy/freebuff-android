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
  sanitizeEnv,
  ELF_AARCH64,
} = require('../../index.js');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** ELF64 mínimo con un PT_INTERP (type 3) y e_machine AARCH64. */
function elfWithInterp(interp) {
  const interpBuf = Buffer.from(interp + '\0');
  const phoff = 64;
  const phentsize = 56;
  const pOffset = phoff + phentsize; // 120
  const buf = Buffer.alloc(pOffset + interpBuf.length);
  ELF_MAGIC.copy(buf, 0);
  buf.writeUInt8(2, 4); // ELFCLASS64
  buf.writeUInt8(1, 5); // little endian
  buf.writeUInt16LE(ELF_AARCH64, 18);
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(1, 56); // phnum
  buf.writeUInt32LE(3, phoff); // PT_INTERP
  buf.writeBigUInt64LE(BigInt(pOffset), phoff + 8);
  buf.writeBigUInt64LE(BigInt(interpBuf.length), phoff + 32); // p_filesz
  interpBuf.copy(buf, pOffset);
  return buf;
}

test('sanitizeEnv elimina LD_PRELOAD y LD_LIBRARY_PATH', () => {
  const clean = sanitizeEnv({
    HOME: '/x',
    LD_PRELOAD: '/data/data/com.termux/files/usr/lib/libtermux-exec-ld-preload.so',
    LD_LIBRARY_PATH: '/data/data/com.termux/files/usr/glibc/lib',
    TERM: 'xterm-256color',
  });
  assert.equal('LD_PRELOAD' in clean, false);
  assert.equal('LD_LIBRARY_PATH' in clean, false);
  assert.equal(clean.TERM, 'xterm-256color');
});

test('readElfInterp parsea PT_INTERP de un ELF64', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-interp-'));
  try {
    const file = path.join(dir, 'bin');
    fs.writeFileSync(file, elfWithInterp('/lib/ld-linux-aarch64.so.1'));
    const io = defaultIo({});
    assert.equal(io.readElfInterp(file), '/lib/ld-linux-aarch64.so.1');
    // No-ELF → null.
    fs.writeFileSync(path.join(dir, 'noelf'), 'not an elf');
    assert.equal(io.readElfInterp(path.join(dir, 'noelf')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLoader localiza el loader glibc derivado de $PREFIX', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-loader-'));
  try {
    const prefix = path.join(dir, 'usr');
    fs.mkdirSync(path.join(prefix, 'glibc', 'lib'), { recursive: true });
    const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
    fs.writeFileSync(loader, 'loader');
    const config = createConfig({ HOME: dir, PREFIX: prefix });
    const io = defaultIo({ config });
    assert.equal(io.findLoader(config), loader);
    // Sin PREFIX → null.
    const ioNoPrefix = defaultIo({ config: createConfig({ HOME: dir }) });
    assert.equal(ioNoPrefix.findLoader(createConfig({ HOME: dir })), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareDirectRun reescribe el intérprete cuando no es el loader real', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-prep-'));
  try {
    const prefix = path.join(dir, 'usr');
    const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'loader');
    const config = createConfig({ HOME: dir, PREFIX: prefix });
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, elfWithInterp('/lib/ld-linux-aarch64.so.1'), {
      mode: 0o755,
    });

    let patchedWith = null;
    const io = defaultIo({ config });
    const wrapper = createWrapper({
      config,
      io: {
        ...io,
        patchelfInterp: (bin, interp) => {
          patchedWith = { bin, interp };
          // Simula el resultado: el archivo ya tiene el interp correcto.
          fs.writeFileSync(bin, elfWithInterp(loader), { mode: 0o755 });
          return true;
        },
        directSmokeTest: () => true,
      },
    });

    const result = await wrapper.prepareDirectRun();
    assert.equal(result.mode, 'direct');
    assert.equal(result.interp, loader);
    assert.ok(patchedWith, 'patchelf debe ejecutarse');
    assert.equal(patchedWith.interp, loader);
    // El binario instalado quedó con el interp correcto.
    assert.equal(io.readElfInterp(config.binaryPath), loader);
    // Sin copias temporales sueltas.
    assert.ok(!fs.existsSync(path.join(config.tempDir, 'freebuff.direct')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareDirectRun es idempotente y no parchea si ya está bien', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-prep2-'));
  try {
    const prefix = path.join(dir, 'usr');
    const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'loader');
    const config = createConfig({ HOME: dir, PREFIX: prefix });
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, elfWithInterp(loader), { mode: 0o755 });

    let patchelfCalls = 0;
    const wrapper = createWrapper({
      config,
      io: {
        ...defaultIo({ config }),
        patchelfInterp: () => {
          patchelfCalls++;
          return true;
        },
        directSmokeTest: () => true,
      },
    });

    const result = await wrapper.prepareDirectRun();
    assert.equal(result.mode, 'direct');
    assert.equal(patchelfCalls, 0, 'no debe parchear si el interp ya es correcto');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareDirectRun cae a modo grun si patchelf falla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-prep3-'));
  try {
    const prefix = path.join(dir, 'usr');
    const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'loader');
    const config = createConfig({ HOME: dir, PREFIX: prefix });
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, elfWithInterp('/lib/ld-linux-aarch64.so.1'), {
      mode: 0o755,
    });

    const wrapper = createWrapper({
      config,
      io: {
        ...defaultIo({ config }),
        patchelfInterp: () => false, // patchelf falla
        directSmokeTest: () => true,
      },
    });

    const result = await wrapper.prepareDirectRun();
    assert.equal(result.mode, 'grun');
    // El binario original queda intacto.
    assert.equal(
      wrapper.io.readElfInterp(config.binaryPath),
      '/lib/ld-linux-aarch64.so.1',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareDirectRun cae a modo grun si el smoke test directo falla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-prep4-'));
  try {
    const prefix = path.join(dir, 'usr');
    const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'loader');
    const config = createConfig({ HOME: dir, PREFIX: prefix });
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(config.binaryPath, elfWithInterp('/lib/ld-linux-aarch64.so.1'), {
      mode: 0o755,
    });

    const wrapper = createWrapper({
      config,
      io: {
        ...defaultIo({ config }),
        patchelfInterp: () => true,
        directSmokeTest: () => false, // el binario reescrito no arranca
      },
    });

    const result = await wrapper.prepareDirectRun();
    assert.equal(result.mode, 'grun');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
