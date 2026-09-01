/*
 * dns-redirect.c — LD_PRELOAD shim para Termux.
 *
 * Los binarios glibc/Bun (p.ej. el binario de Freebuff) resuelven DNS leyendo
 * literalmente /etc/resolv.conf. En Android ese archivo NO existe (solo lo
 * podría crear root), así que el resolver cae a su valor por defecto
 * (127.0.0.1:53) y toda resolución muere con "getaddrinfo ETIMEOUT".
 *
 * Este shim intercepta las llamadas de apertura/estadística y redirige
 * "/etc/resolv.conf" al resolv.conf real de glibc-runner
 * ($PREFIX/etc/resolv.conf, con nameserver 8.8.8.8, que SÍ responde por UDP
 * directo desde apps de Android). Sin root, sin PRoot, sin daemons.
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
    if (flags & (0x40 /*O_CREAT*/ | 0x200 /*O_TMPFILE*/)) {
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
    if (flags & (0x40 | 0x200)) mode = (unsigned int)va_arg(ap, int);
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

/* ---- stat / lstat / stat64 / lstat64 ---- */
typedef int (*stat_fn)(const char *, void *);

static int do_stat(const char *real_name, const char *path, void *buf) {
    stat_fn real = (stat_fn)dlsym(RTLD_NEXT, real_name);
    if (should_redirect(path)) path = resolv_source();
    return real ? real(path, buf) : -1;
}
int stat(const char *path, void *buf) { return do_stat("stat", path, buf); }
int stat64(const char *path, void *buf) { return do_stat("stat64", path, buf); }
int lstat(const char *path, void *buf) { return do_stat("lstat", path, buf); }
int lstat64(const char *path, void *buf) { return do_stat("lstat64", path, buf); }

/* glibc <= 2.32 (ya no existen en modernas; si no se llaman, no importa). */
int __xstat(int ver, const char *path, void *buf) {
    (void)ver;
    return do_stat("__xstat", path, buf);
}
int __xstat64(int ver, const char *path, void *buf) {
    (void)ver;
    return do_stat("__xstat64", path, buf);
}
int __lxstat(int ver, const char *path, void *buf) {
    (void)ver;
    return do_stat("__lxstat", path, buf);
}
int __lxstat64(int ver, const char *path, void *buf) {
    (void)ver;
    return do_stat("__lxstat64", path, buf);
}

/* ---- access / fstatat / faccessat ---- */
int access(const char *path, int mode) {
    int (*real)(const char *, int) = (int (*)(const char *, int))dlsym(RTLD_NEXT, "access");
    if (should_redirect(path)) path = resolv_source();
    return real ? real(path, mode) : -1;
}

typedef int (*fstatat_fn)(int, const char *, void *, int);

static int do_fstatat(int dirfd, const char *path, void *buf, int flags, int is64) {
    fstatat_fn real = (fstatat_fn)dlsym(RTLD_NEXT, is64 ? "fstatat64" : "fstatat");
    if (should_redirect(path)) path = resolv_source();
    return real ? real(dirfd, path, buf, flags) : -1;
}
int fstatat(int dirfd, const char *path, void *buf, int flags) {
    return do_fstatat(dirfd, path, buf, flags, 0);
}
int fstatat64(int dirfd, const char *path, void *buf, int flags) {
    return do_fstatat(dirfd, path, buf, flags, 1);
}
int faccessat(int dirfd, const char *path, int mode, int flags) {
    int (*real)(int, const char *, int, int) = (int (*)(int, const char *, int, int))dlsym(RTLD_NEXT, "faccessat");
    if (should_redirect(path)) path = resolv_source();
    return real ? real(dirfd, path, mode, flags) : -1;
}