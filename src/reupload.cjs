const Arweave = require('arweave');
const fs = require('fs');
const path = require('path');

// --- CONFIG -------------------------------------------------------------
// Remove hardcoded values; will be set from argv

// --- ARGV PARSING -------------------------------------------------------
const args = process.argv.slice(2);
if (args.length < 1 || args.includes('-h') || args.includes('--help')) {
  console.error(`Usage: node ${path.basename(process.argv[1])} <txid>`);
  process.exit(1);
}
const TX_ID_TO_UPLOAD = args[0];
const DATA_TO_UPLOAD = path.resolve(`./${TX_ID_TO_UPLOAD}.bin`);

if (!fs.existsSync(DATA_TO_UPLOAD)) {
  console.error(`Error: File not found: ${DATA_TO_UPLOAD}`);
  process.exit(1);
}

// Optional: tune retry behaviour
const MAX_RETRIES_PER_CHUNK = 5;
const RETRY_DELAY_MS_BASE = 750; // backoff base

// --- INIT ARWEAVE CLIENT ------------------------------------------------
const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
});

// --- UTILS --------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node build location for helpers varies; try/catch fallbacks:
let validatePath, ArweaveUtils;
try {
  ({ validatePath } = require('arweave/node/lib/merkle'));
  ArweaveUtils = require('arweave/node/lib/utils');
} catch (e) {
  // Fallback for bundlers / alt paths
  ({ validatePath } = require('arweave/lib/merkle'));
  ArweaveUtils = require('arweave/lib/utils');
}

// --- MAIN ---------------------------------------------------------------
(async () => {
  // 1. Load local data
  const data = fs.readFileSync(DATA_TO_UPLOAD);

  // 2. Fetch the already-created transaction
  const tx_ = await arweave.transactions.get(TX_ID_TO_UPLOAD);
  const uploader = await arweave.transactions.getUploader(tx_, data);
  const tx = uploader.transaction;
  const totalChunks = tx.chunks.chunks.length;

  console.log(
    `Uploading ${totalChunks} chunk(s) for transaction ${TX_ID_TO_UPLOAD}...`,
  );

  // 3. Walk each chunk index and POST directly (skip posting tx)
  for (let i = 0; i < totalChunks; i++) {
    let attempt = 0;
    while (true) {
      try {
        // Recreate the chunk structure exactly as arweave-js does:
        // getChunk(index, data) returns { data_root, data_size, data_path, offset, chunk }
        const chunkObj = tx.getChunk(i, data);

        // Optional local validation (mirrors your snippet)
        const chunkOk = await validatePath(
          tx.chunks.data_root,
          parseInt(chunkObj.offset, 10),
          0,
          parseInt(chunkObj.data_size, 10),
          ArweaveUtils.b64UrlToBuffer(chunkObj.data_path),
        );
        if (!chunkOk) {
          throw new Error(`Unable to validate chunk ${i}`);
        }

        // POST the chunk
        const resp = await arweave.api.post('chunk', chunkObj).catch((e) => {
          // Normalize network errors to a response-like object
          console.error(`Network error posting chunk ${i}: ${e.message}`);
          return { status: -1, data: { error: e.message } };
        });

        if (resp.status === 200 || resp.status === 208) {
          // 208 Already Reported: chunk already present – treat as success
          console.log(
            `Chunk ${i + 1}/${totalChunks} uploaded. (status ${resp.status})`,
          );
          break;
        } else {
          throw new Error(
            `Chunk ${i} upload failed (status ${resp.status}): ${JSON.stringify(resp.data)}`,
          );
        }
      } catch (err) {
        attempt += 1;
        if (attempt > MAX_RETRIES_PER_CHUNK) {
          console.error(
            `❌ Giving up on chunk ${i} after ${MAX_RETRIES_PER_CHUNK} retries.`,
          );
          console.error(err);
          process.exit(1);
        } else {
          const delay = RETRY_DELAY_MS_BASE * attempt;
          console.warn(
            `Retry ${attempt}/${MAX_RETRIES_PER_CHUNK} for chunk ${i} in ${delay}ms... (${err.message})`,
          );
          await sleep(delay);
        }
      }
    }
  }

  console.log(
    '✅ All chunks attempted. Note: We did NOT (re)post the transaction body.',
  );
  console.log(
    'If all chunks returned 200/208, the gateway should be able to assemble the full data.',
  );
})();
