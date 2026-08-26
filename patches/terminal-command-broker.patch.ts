/**
 * PATCH: defaultBrokerInvocation() in cli/src/utils/terminal-command-broker.ts
 *
 * PROBLEM: When running via grun (Termux glibc-runner), the Bun binary is
 * invoked as: ld.so /path/to/freebuff-binary [args]
 * This makes /proc/self/exe and process.execPath point to ld.so, not the
 * binary. The terminal command broker then spawns process.execPath with
 * --terminal-command-broker, which lands on ld.so and fails.
 *
 * SOLUTION: Check for the FREEBUFF_ANDROID_BROKER_SHIM env var. When set (and
 * the file exists), the wrapper's shim script is used as the broker
 * executable instead of process.execPath. The shim re-invokes grun with the
 * real binary, so the broker flag reaches the binary. See lib/broker-shim.sh.
 *
 * The wrapper (index.js) sets:
 *   FREEBUFF_ANDROID_BIN           → path of the installed binary
 *   FREEBUFF_ANDROID_GRUN          → grun/glibc-runner command
 *   FREEBUFF_ANDROID_BROKER_SHIM   → path of the shim script
 *
 * IMPORTANT: This is a patch to the Freebuff CLI source. The official
 * release binary will only honour the shim if it was built from a source
 * tree with this patch applied. Aplicador idempotente: `node patches/apply.js`.
 *
 * ORIGINAL CODE (line ~339):
 * ```
 * function defaultBrokerInvocation(): {
 *   executable: string
 *   args: string[]
 * } {
 *   return {
 *     executable: process.execPath,
 *     args:
 *       getCliEnv().CODEBUFF_IS_BINARY === 'true'
 *         ? [TERMINAL_COMMAND_BROKER_FLAG]
 *         : [
 *             path.join(import.meta.dir, '..', 'entry.ts'),
 *             TERMINAL_COMMAND_BROKER_FLAG,
 *           ],
 *   }
 * }
 * ```
 *
 * PATCHED CODE (lo que aplica patches/apply.js):
 * ```
 * function defaultBrokerInvocation(): {
 *   executable: string
 *   args: string[]
 * } {
 *   // Android/Termux: process.execPath may point to ld.so when invoked via grun.
 *   // Use a shim script that re-invokes grun with the real binary instead.
 *   const androidBrokerShim = getSystemProcessEnv().FREEBUFF_ANDROID_BROKER_SHIM
 *   if (androidBrokerShim && existsSync(androidBrokerShim)) {
 *     return {
 *       executable: androidBrokerShim,
 *       args: [TERMINAL_COMMAND_BROKER_FLAG],
 *     }
 *   }
 *
 *   return {
 *     executable: process.execPath,
 *     args:
 *       getCliEnv().CODEBUFF_IS_BINARY === 'true'
 *         ? [TERMINAL_COMMAND_BROKER_FLAG]
 *         : [
 *             path.join(import.meta.dir, '..', 'entry.ts'),
 *             TERMINAL_COMMAND_BROKER_FLAG,
 *           ],
 *   }
 * }
 * ```
 *
 * Tambien añade `existsSync` al import de 'fs'.
 */
