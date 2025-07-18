import path from 'path';
import axios from 'axios';
import { checkTx } from './check-irys-bundle.mjs';
import { fetchArweaveChunks } from './fetch-arweave-chunks.mjs';
import { reuploadChunks } from './reupload.mjs';

function pollArweave(txid, { interval = 10000, maxAttempts = 100, logger = console.log } = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    async function check() {
      attempts++;
      try {
        const resp = await axios.head(`https://arweave.net/${txid}`);
        if (resp.status === 200) {
          logger(`\n✅ Tx ${txid} is now available on Arweave!`);
          return resolve(true);
        }
      } catch (err) {
        // ignore, will retry
      }
      if (attempts >= maxAttempts) {
        reject(new Error(`Gave up after ${maxAttempts} attempts.`));
      } else {
        logger('.');
        setTimeout(check, interval);
      }
    }
    check();
  });
}

export async function fixArweaveTx(txid, { logger = console.log, errorLogger = console.error } = {}) {
  // 1. Check if tx is already on Arweave or Irys
  let bundleId;
  let seeds;
  logger(`Checking Arweave for ${txid}`);
  try {
    const res = await checkTx(txid);
    if (res.source === 'arweave') {
      logger(`Found on Arweave. No action needed.`);
      return { status: 'already_on_arweave' };
    }
    if (res.source !== 'irys') {
      logger(`Not found. No bundle available on Irys. Exiting.`);
      return { status: 'not_found_on_irys' };
    }
    logger(`Not found. Checking Irys for bundle...`);
    bundleId = res.bundle_id;
    seeds = res.seeds;
  } catch (err) {
    errorLogger('Failed to check bundle status:', err.message);
    throw err;
  }
  logger(`Bundle id from Irys: ${bundleId}`);

  // 2. Fetch chunks
  try {
    const peerList = seeds && Array.isArray(seeds) && seeds.length > 0 ? seeds : undefined;
    if (peerList) {
      logger(`\nFetching chunks for bundle id ${bundleId} with discovered peers: [${peerList.join(', ')}]`);
    } else {
      logger(`\nFetching chunks for bundle id ${bundleId} with default peers.`);
    }
    await fetchArweaveChunks(
      {
        txid: bundleId,
        peers: peerList,
        timeout: 120000,
        verbose: false,
      },
      { logger, errorLogger }
    );
  } catch (err) {
    errorLogger('Failed to fetch chunks:', err.message);
    throw err;
  }

  // 3. Reupload
  try {
    logger(`\nReuploading chunks for bundle id ${bundleId}...`);
    await reuploadChunks(bundleId, { logger, errorLogger });
  } catch (err) {
    errorLogger('Failed to reupload chunks:', err.message);
    throw err;
  }

  // 4. Poll Arweave
  try {
    logger(`\nPolling Arweave for tx ${txid}...`);
    await pollArweave(txid, { logger });
    return { status: 'fixed' };
  } catch (err) {
    errorLogger('\nPolling failed:', err.message);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(`Usage: node ${path.basename(process.argv[1])} <txid>`);
    process.exit(1);
  }
  fixArweaveTx(args[0], { logger: console.log, errorLogger: console.error }).catch(() => process.exit(1));
}
