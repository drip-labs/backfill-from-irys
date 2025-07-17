import path from 'path';
import axios from 'axios';
import { checkTx } from './check-irys-bundle.mjs';
import { fetchArweaveChunks } from './fetch-arweave-chunks.mjs';
import { reuploadChunks } from './reupload.mjs';

function pollArweave(txid, { interval = 10000, maxAttempts = 60 } = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    async function check() {
      attempts++;
      try {
        const resp = await axios.head(`https://arweave.net/${txid}`);
        if (resp.status === 200) {
          console.log(`\n✅ Tx ${txid} is now available on Arweave!`);
          return resolve(true);
        }
      } catch (err) {
        // ignore, will retry
      }
      if (attempts >= maxAttempts) {
        reject(new Error(`Gave up after ${maxAttempts} attempts.`));
      } else {
        process.stdout.write('.');
        setTimeout(check, interval);
      }
    }
    check();
  });
}

async function main(txid) {
  // 1. Check if tx is already on Arweave or Irys
  let bundleId;
  let seeds;
  console.log(`Checking Arweave for ${txid}`);
  try {
    const res = await checkTx(txid);
    if (res.source === 'arweave') {
      console.log(`Found on Arweave. No action needed.`);
      return;
    }
    if (res.source !== 'irys') {
      console.log(`Not found. No bundle available on Irys. Exiting.`);
      return;
    }
    console.log(`Not found. Checking Irys for bundle...`);
    bundleId = res.bundle_id;
    seeds = res.seeds;
  } catch (err) {
    console.error('Failed to check bundle status:', err.message);
    throw err;
  }
  console.log(`Bundle id from Irys: ${bundleId}`);

  // 2. Fetch chunks
  try {
    const peerList = seeds && Array.isArray(seeds) && seeds.length > 0 ? seeds : undefined;
    if (peerList) {
      console.log(`\nFetching chunks for bundle id ${bundleId} with discovered peers: [${peerList.join(', ')}]`);
    } else {
      console.log(`\nFetching chunks for bundle id ${bundleId} with default peers.`);
    }
    await fetchArweaveChunks({ txid: bundleId, peers: peerList });
  } catch (err) {
    console.error('Failed to fetch chunks:', err.message);
    throw err;
  }

  // 3. Reupload
  try {
    console.log(`\nReuploading chunks for bundle id ${bundleId}...`);
    await reuploadChunks(bundleId);
  } catch (err) {
    console.error('Failed to reupload chunks:', err.message);
    throw err;
  }

  // 4. Poll Arweave
  try {
    console.log(`\nPolling Arweave for tx ${txid}...`);
    await pollArweave(txid);
  } catch (err) {
    console.error('\nPolling failed:', err.message);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(`Usage: node ${path.basename(process.argv[1])} <txid>`);
    process.exit(1);
  }
  main(args[0]).catch(() => process.exit(1));
} 