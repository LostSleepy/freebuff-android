/*
 * dns-redirect.c — LD_PRELOAD shim para Termux.
 *
 * Los binarios glibc/Bun (p.ej. el binario de Freebuff) resuelven DNS leyendo
 * literalmente /etc/resolv.conf. En Android ese archivo NO existe (solo lo
 * podría crear root), así que el resolver cae a su valor por defecto
 * (127.0.0.1:53) y toda resolución muere con "getaddrinfo ETIMEOUT".
 *
 * Este shim intercepta las llamadas de APERTURA (open/open64/openat/openat64
 * y sus variantes fortify __open*_2/__openat*_2, más fopen/fopen64) y
 * redirige "/etc/resolv.conf" al resolv.conf real de glibc-runner
 * ($PREFIX/etc/resolv.conf, con nameserver 8.8.8.8, que SÍ responde por UDP
 * directo desde apps de Android). Sin root, sin PRoot, sin daemons.
 *
 * IMPORTANTE: NO intercepta stat/lstat/access/faccessat/fstatat ni la familia
 * __xstat/__lxstat. La v0.4.0 interceptaba esa familia y eso rompía la
 * resolución de ejecutables por PATH del runtime de Bun: el terminal command
 * broker (que re-ejecuta el binario) fallaba con "Executable not found in
 * $PATH: bash" para TODOS los comandos. El runtime de Bun interpone sus
 * propias versiones de esos símbolos, así que dlsym(RTLD_NEXT, "stat") desde
 * el shim resuelve a la implementación de Bun (no a glibc) y devuelve ENOENT
 * para rutas normales. Además la familia stat/access NO hace falta: el
 * resolver (c-ares/Bun y glibc) abre /etc/resolv.conf con fopen/open, no lo
 * comprueba solo con stat. El redirect de apertura es suficiente y no toca el
 * PATH lookup del broker.
 *
 * Compilación (aarch64):
 *   clang -shared -fPIC -O2 -nostdlib \
 *     -I/data/data/com.termux/files/usr/glibc/include \
 *     -o dns-redirect-aarch64.so dns-redirect.c
 *
 * Se compila con -nostdlib a propósito: sin DT_NEEDED, los símbolos
 * dlsym/getenv/strcmp quedan undefined y se resuelven al cargar contra la
 * libc del proceso anfitrión (glibc), que es exactamente lo que queremos.
 *
 * Uso:
 *   LD_PRELOAD=ruta/dns-redirect-aarch64.so binario-glibc ...
 *   (FREEBUFF_RESOLV_CONF apunta al resolv.conf origen; por defecto
 *    /data/data/com.termux/files/usr/etc/resolv.conf)
 */

#define _GNU_SOURCE
#include <stddef.h>
#include <stdarg.h>

typedef void *Handle;

/* Exportados por glibc (libc >= 2.34 incluye libdl). Sin -nostdlib no
 * habría DT_NEEDED; estas referencias se resuelven del ámbito global. */
extern void *dlsym(Handle handle, const char *symbol);
extern const char *getenv(const char *name);
extern int strcmp(const char *a, const char *b);

#define RTLD_NEXT ((Handle)-1)

#define DEFAULT_RESOLV_SOURCE "/data/data/com.termux/files/usr/etc/resolv.conf"
#define TARGET_PATH "/etc/resolv.conf"

static const char *resolv_source(void) {
    const char *v = getenv("FREEBUFF_RESOLV_CONF");
    if (v && v[0]) return v;
    return DEFAULT_RESOLV_SOURCE;
}

static int should_redirect(const char *path) {
    if (!path) return 0;
    return strcmp(path, TARGET_PATH) == 0;
}

#define REDIRECT(path) ((path) = resolv_source())

/* ---- open / open64 (+ variantes fortify __open*_2) ---- */
typedef int (*open_fn)(const char *, int, ...);

static int do_open(const char *path, int flags, va_list ap, int is64) {
    open_fn real = (open_fn)dlsym(RTLD_NEXT, is64 ? "open64" : "open");
    if (should_redirect(path)) path = resolv_source();
    if (!real) return -1;
    /* El modo solo aplica al crear; pasarlo siempre es inocuo. */
    unsigned int mode = 0;
    if (flags & 0x40 /*O_CREAT*/) {
        mode = (unsigned int)va_arg(ap, int);
    }
    return real(path, flags, mode);
}

int open(const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_open(path, flags, ap, 0);
    va_end(ap); return r;
}
int open64(const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_open(path, flags, ap, 1);
    va_end(ap); return r;
}
int __open_2(const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_open(path, flags, ap, 0);
    va_end(ap); return r;
}
int __open64_2(const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_open(path, flags, ap, 1);
    va_end(ap); return r;
}

/* ---- openat / openat64 ---- */
typedef int (*openat_fn)(int, const char *, int, ...);

static int do_openat(int dirfd, const char *path, int flags, va_list ap, int is64) {
    openat_fn real = (openat_fn)dlsym(RTLD_NEXT, is64 ? "openat64" : "openat");
    /* Para paths absolutos el dirfd se ignora; redirigir igualmente. */
    if (should_redirect(path)) path = resolv_source();
    if (!real) return -1;
    unsigned int mode = 0;
    if (flags & 0x40) mode = (unsigned int)va_arg(ap, int);
    return real(dirfd, path, flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_openat(dirfd, path, flags, ap, 0);
    va_end(ap); return r;
}
int openat64(int dirfd, const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_openat(dirfd, path, flags, ap, 1);
    va_end(ap); return r;
}
int __openat_2(int dirfd, const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_openat(dirfd, path, flags, ap, 0);
    va_end(ap); return r;
}
int __openat64_2(int dirfd, const char *path, int flags, ...) {
    va_list ap; va_start(ap, flags);
    int r = do_openat(dirfd, path, flags, ap, 1);
    va_end(ap); return r;
}

/* ---- fopen / fopen64 ---- */
typedef void *(*fopen_fn)(const char *, const char *);

void *fopen(const char *path, const char *mode) {
    fopen_fn real = (fopen_fn)dlsym(RTLD_NEXT, "fopen");
    if (should_redirect(path)) path = resolv_source();
    return real ? real(path, mode) : 0;
}
void *fopen64(const char *path, const char *mode) {
    fopen_fn real = (fopen_fn)dlsym(RTLD_NEXT, "fopen64");
    if (should_redirect(path)) path = resolv_source();
    return real ? real(path, mode) : 0;
}
