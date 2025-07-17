#!/usr/bin/env node
/*
 * check-irys-bundle.cjs
 * ---------------------------------------------
 * Given a transaction ID, checks if it is bundled in Arweave (via arweave-search.goldsky.com).
 * If not, checks Irys for a bundle id. Only outputs if the source is 'irys'.
 *
 * Usage:
 *   node check-irys-bundle.cjs <txid>
 *
 * Example:
 *   node check-irys-bundle.cjs SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function usage() {
  console.log(`Usage: node ${require('path').basename(process.argv[1])} <txid>\n`);
  console.log('Example:');
  console.log(`  node ${require('path').basename(process.argv[1])} SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo`);
}

function getJSON(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: opts.timeout || 10000,
        headers: opts.headers || { Accept: 'application/json' },
      },
      (res) => {
        const { statusCode } = res;
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            try {
              const json = JSON.parse(buf.toString('utf8'));
              resolve(json);
            } catch (err) {
              reject(new Error(`Invalid JSON from ${urlStr}: ${err.message}`));
            }
          } else {
            reject(new Error(`HTTP ${statusCode} from ${urlStr}: ${buf.toString('utf8')}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function postJSON(urlStr, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        timeout: opts.timeout || 10000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(opts.headers || {}),
        },
      },
      (res) => {
        const { statusCode } = res;
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            try {
              const json = JSON.parse(buf.toString('utf8'));
              resolve(json);
            } catch (err) {
              reject(new Error(`Invalid JSON from ${urlStr}: ${err.message}`));
            }
          } else {
            reject(new Error(`HTTP ${statusCode} from ${urlStr}: ${buf.toString('utf8')}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function checkTxArweaveBundle(tx_id) {
  const query = {
    query: `query {\n  transaction(id: \"${tx_id}\") {\n    id\n    data { size }\n    bundledIn { id }\n  }\n}`,
  };
  try {
    const resp = await postJSON('https://arweave-search.goldsky.com/graphql', query);
    const t = resp && resp.data && resp.data.transaction;
    if (t && t.id === tx_id && t.bundledIn && t.bundledIn.id) {
      return t.bundledIn.id;
    }
    return null;
  } catch (err) {
    // Optionally log error
    return null;
  }
}

async function checkTxIrysBundle(tx_id) {
  try {
    const resp = await getJSON(`https://node1.irys.xyz/tx/${tx_id}/status`);
    if (resp && resp.status === 'FINALIZED' && resp.bundleTxId) {
      return resp.bundleTxId;
    }
    return null;
  } catch (err) {
    // Optionally log error
    return null;
  }
}

async function checkTx(tx_id) {
  // Check Arweave first
  const arweaveBundle = await checkTxArweaveBundle(tx_id);
  if (arweaveBundle) {
    return { tx_id, bundle_id: arweaveBundle, source: 'arweave' };
  }
  // Check Irys
  const irysBundle = await checkTxIrysBundle(tx_id);
  if (irysBundle) {
    return { tx_id, bundle_id: irysBundle, source: 'irys' };
  }
  return { tx_id, bundle_id: null, source: 'none' };
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  const txid = args[0];
  try {
    const res = await checkTx(txid);
    if (res.source === 'irys') {
      console.log(res.bundle_id);
    }
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})(); 