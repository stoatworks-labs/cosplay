/**
 * stdout is the protocol. Anything a library prints goes to stderr instead: one stray
 * `console.log` is a corrupt message. This is a module of its own, imported first by
 * `server.ts`, because imports run in order and a library that logs while it loads would
 * otherwise get in ahead of the redirect.
 */

const toStderr = console.error.bind(console)
console.log = console.info = console.debug = console.warn = toStderr
