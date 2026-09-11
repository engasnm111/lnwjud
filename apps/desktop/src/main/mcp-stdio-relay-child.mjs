// Runs as a plain Node.js process (Electron sets ELECTRON_RUN_AS_NODE=1 automatically
// for child_process.fork()), spawned with stdio ['inherit','inherit','inherit','ipc']
// so it inherits the REAL external stdin/stdout handle from whatever launched the
// packaged Electron app. This works around a long-standing Electron limitation on
// Windows where the main process's own `process.stdin` is a mock stream that
// immediately reports EOF (electron/electron#21705, #11680) — the raw OS handle is
// still valid, it just cannot be read from inside Electron's main process there.
// This script has no knowledge of the MCP protocol: it only relays raw bytes between
// the real external pipes and the Electron main process over the IPC channel.

process.stdin.on('data', (chunk) => {
  if (typeof process.send === 'function') {
    process.send({ channel: 'lnwjud-stdio-relay', kind: 'in', data: chunk.toString('base64') });
  }
});

process.stdin.on('end', () => {
  if (typeof process.send === 'function') {
    process.send({ channel: 'lnwjud-stdio-relay', kind: 'end' });
  }
});

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;
  if (message.channel !== 'lnwjud-stdio-relay') return;
  if (message.kind === 'out' && typeof message.data === 'string') {
    process.stdout.write(Buffer.from(message.data, 'base64'));
  } else if (message.kind === 'close') {
    process.exit(0);
  }
});

process.on('disconnect', () => process.exit(0));
