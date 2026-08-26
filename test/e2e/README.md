# Regresión E2E: terminal command broker

Estos tests son una copia **verbatim** de los tests E2E oficiales del
terminal command broker del CLI de Freebuff/Codebuff
(`cli/src/utils/__tests__/terminal-command-broker.test.ts` + `fixtures/`).

Se conservan como regresión del comportamiento del broker: validan el
protocolo de un solo uso, aislamiento de procesos, propagación de salida/código
de salida, timeouts con kill del grupo de procesos, reaping cuando el padre
desaparece, etc.

## Cómo ejecutarlos

Dependen de `@codebuff/sdk` y del módulo local del CLI, así que se corren
dentro de un checkout del source con **bun**:

```bash
# 1. En el checkout, instala dependencias (solo la primera vez)
cd /ruta/al/checkout-de-codebuff
bun install

# 2. Desde el proyecto freebuff-android
bash test/e2e/run.sh /ruta/al/checkout-de-codebuff
```

`run.sh` copia test + fixtures, aplica el parche del broker
(`patches/apply.js`, idempotente) y ejecuta `bun test`.

## La prueba negativa (por qué el shim es necesario)

Investigación de `sandbox/freebuff-src/`: ejecutando el binario Bun a través
de `grun` (glibc-runner), `process.execPath` y `/proc/self/exe` apuntan a
`ld.so`, no al binario. El broker entonces intenta
`spawn(ld.so, ['--terminal-command-broker'])`, que falla.

La prueba negativa consistió en arrancar el binario vía el loader con el flag
de broker **sin** shim (`mock-grun` + `selfpath.js` en el sandbox): el broker
no puede re-ejecutarse y el comando termina en error. Con el shim
(`FREEBUFF_ANDROID_BROKER_SHIM` + parche del CLI) el flag llega al binario y
el broker funciona.

**Conclusión:** el shim es necesario **y** el binario debe estar compilado con
el parche de `patches/`. `android-doctor` ejecuta una E2E mínima del broker a
través del shim para detectar si el binario instalado lo soporta.
