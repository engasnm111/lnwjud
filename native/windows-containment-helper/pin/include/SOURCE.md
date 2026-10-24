# Node N-API headers

These four headers are copied without changes from the official Node.js 24.16.0
headers archive. The containment addon uses the stable N-API ABI, including when
loaded by Electron. Building does not depend on a machine's node-gyp cache.

- Source: https://nodejs.org/download/release/v24.16.0/node-v24.16.0-headers.tar.gz
- Archive SHA-256: `ee3466c7ed5101cdc82978a5164148204bfffae0ddacda24ef6d9805bdf4fc07`
- Official checksums: https://nodejs.org/download/release/v24.16.0/SHASUMS256.txt
- License: https://github.com/nodejs/node/blob/v24.16.0/LICENSE

The adjacent LICENSE is the complete upstream license file. The build script
checks each header's SHA-256 before invoking the compiler.
