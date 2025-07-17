#!/usr/bin/env node
/*
 * check-irys-bundle.mjs
 * ---------------------------------------------
 * Given a transaction ID, checks if it is bundled in Arweave (via arweave-search.goldsky.com).
 * If not, checks Irys for a bundle id. Only outputs if the source is 'irys'.
 *
 * Usage:
 *   node check-irys-bundle.mjs <txid>
 *
 * Example:
 *   node check-irys-bundle.mjs SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import path from 'path';
import axios from 'axios';

function usage() {
  console.log(`Usage: node ${path.basename(process.argv[1])} <txid>\n`);
  console.log('Example:');
  console.log(`  node ${path.basename(process.argv[1])} SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo`);
}

async function checkTxArweaveExists(tx_id) {
  try {
    const resp = await axios.head(`https://arweave.net/${tx_id}`, { maxRedirects: 3 });
    const statusOk = resp.status >= 200 && resp.status < 300;
    const contentLength = parseInt(resp.headers['content-length'] || '0', 10);
    return statusOk && contentLength > 0;
  } catch (err) {
    return false;
  }
}

async function checkTxIrysBundle(tx_id) {
  try {
    const resp = await axios.get(`https://node1.irys.xyz/tx/${tx_id}/status`, { timeout: 10000 });
    if (resp.data && resp.data.status === 'FINALIZED' && resp.data.bundleTxId) {
      return resp.data;
    }
    return null;
  } catch (err) {
    // Optionally log error
    return null;
  }
}

export async function checkTx(tx_id) {
  // Check Arweave first
  const arweaveFound = await checkTxArweaveExists(tx_id);
  if (arweaveFound) {
    return { tx_id, bundle_id: null, source: 'arweave' };
  }
  // Check Irys
  const irysBundle = await checkTxIrysBundle(tx_id);
  if (irysBundle) {
    return { tx_id, bundle_id: irysBundle.bundleTxId, seeds: irysBundle.seededTo, source: 'irys' };
  }
  return { tx_id, bundle_id: null, source: 'none' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  const txid = args[0];
  try {
    const res = await checkTx(txid);
    if (res.source === 'irys') {
      console.log(res);
    }
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
} 