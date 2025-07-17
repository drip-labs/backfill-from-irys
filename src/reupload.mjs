import Arweave from 'arweave';
import fs from 'fs';
import path from 'path';
import { validatePath } from 'arweave/node/lib/merkle.js';
import * as ArweaveUtils from 'arweave/node/lib/utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function reuploadChunks(TX_ID_TO_UPLOAD, { logger = console.log, errorLogger = console.error } = {}) {
  const DATA_TO_UPLOAD = path.resolve(`./${TX_ID_TO_UPLOAD}.bin`);
  if (!fs.existsSync(DATA_TO_UPLOAD)) {
    throw new Error(`File not found: ${DATA_TO_UPLOAD}`);
  }
  const MAX_RETRIES_PER_CHUNK = 5;
  const RETRY_DELAY_MS_BASE = 750;
  const arweave = Arweave.init({
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
  });
  // 1. Load local data
  const data = fs.readFileSync(DATA_TO_UPLOAD);
  // 2. Fetch the already-created transaction
  const tx_ = await arweave.transactions.get(TX_ID_TO_UPLOAD);
  const uploader = await arweave.transactions.getUploader(tx_, data);
  const tx = uploader.transaction;
  const totalChunks = tx.chunks.chunks.length;

  logger(
    `Uploading ${totalChunks} chunk(s) for transaction ${TX_ID_TO_UPLOAD}...`,
  );

  let successCount = 0;
  let failedChunks = [];

  // 3. Walk each chunk index and POST directly (skip posting tx)
  for (let i = 0; i < totalChunks; i++) {
    let attempt = 0;
    let chunkSuccess = false;
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
          errorLogger(`Network error posting chunk ${i}: ${e.message}`);
          return { status: -1, data: { error: e.message } };
        });

        if (resp.status === 200 || resp.status === 208) {
          // 208 Already Reported: chunk already present – treat as success
          logger(
            `Chunk ${i + 1}/${totalChunks} uploaded. (status ${resp.status})`,
          );
          chunkSuccess = true;
          successCount++;
          break;
        } else {
          throw new Error(
            `Chunk ${i} upload failed (status ${resp.status}): ${JSON.stringify(resp.data)}`,
          );
        }
      } catch (err) {
        attempt += 1;
        if (attempt > MAX_RETRIES_PER_CHUNK) {
          errorLogger(
            `❌ Giving up on chunk ${i} after ${MAX_RETRIES_PER_CHUNK} retries.`,
          );
          errorLogger(err);
          failedChunks.push(i + 1);
          break;
        } else {
          const delay = RETRY_DELAY_MS_BASE * attempt;
          logger(
            `Retry ${attempt}/${MAX_RETRIES_PER_CHUNK} for chunk ${i} in ${delay}ms... (${err.message})`,
          );
          await sleep(delay);
        }
      }
    }
  }

  if (successCount === totalChunks) {
    logger(`✅ All ${totalChunks} chunks uploaded successfully for ${TX_ID_TO_UPLOAD}!`);
  } else {
    errorLogger(`❌ Only ${successCount}/${totalChunks} chunks uploaded for ${TX_ID_TO_UPLOAD}. Failed chunks: [${failedChunks.join(', ')}]`);
    throw new Error(`Failed to upload all chunks for ${TX_ID_TO_UPLOAD}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes('-h') || args.includes('--help')) {
    console.error(`Usage: node ${path.basename(process.argv[1])} <txid>`);
    process.exit(1);
  }
  reuploadChunks(args[0], { logger: console.log, errorLogger: console.error }).catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}
