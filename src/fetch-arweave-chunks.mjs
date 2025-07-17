/*
 * fetch-arweave-chunks.mjs
 * ---------------------------------------------
 * Reconstruct the raw data payload for an Arweave transaction by
 * walking the network's chunk storage starting from the transaction's
 * absolute starting offset and downloading each chunk in sequence until
 * the declared transaction size is satisfied.
 *
 * Usage:
 *   node fetch-arweave-chunks.mjs <txid> [outfile] [--peers peer1,peer2,...] [--maxPeers N] [--timeout MS] [--verbose]
 *
 * Example:
 *   node fetch-arweave-chunks.mjs SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo bundle.bin --verbose
 *
 * The script will:
 *   1. Query a gateway (/tx/<id>/offset) to obtain { offset, size }.
 *   2. Compute the absolute starting byte for the transaction data as:
 *        start = BigInt(offset) - BigInt(size) + 1n
 *   3. Build an ordered, de-duplicated peer list from:
 *        - any peers passed on the command line
 *        - a small built-in seed list (arweave.net + a few IPs)
 *        - peers discovered recursively from /peers calls on each reachable peer
 *   4. Iteratively download chunks using GET /chunk/<absoluteOffset>:
 *        - Always request the next unread absolute byte position.
 *        - Because /chunk/<pos> returns the *chunk containing that byte*,
 *          we may receive bytes preceding <pos>; we slice to keep only the new data.
 *        - Use the `offset` field in the response to infer the chunk's end position.
 *   5. Concatenate chunk bytes until `size` bytes are accumulated.
 *   6. Write the complete binary to the specified outfile (default: <txid>.bin).
 *
 * Notes:
 *   • Chunks are <= 256 KiB but may be smaller, especially first/last chunks.
 *   • Responses are JSON: { chunk: <base64url>, data_path: ..., data_root: ..., [offset?: string], [data_size?: string] }
 *   • Base64url must be converted to standard Base64 before decoding.
 *   • The gateway may respond 404 if it does not have the requested chunk; we'll fall back to other peers.
 *   • Some peers speak plain HTTP on port 1984; others front HTTPS (e.g., arweave.net).
 *
 * Exit codes:
 *   0 success, 1 usage, 2 network failure, 3 incomplete (bytes short), 4 other error.
 */

/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { URL } from 'url';

// ------------------------------ CLI ARGS ------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }
  const opts = { peers: [], maxPeers: 500, timeout: 15000, verbose: false };
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--peers') {
      const list = args[++i];
      if (!list) throw new Error('--peers requires a value');
      opts.peers.push(
        ...list
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (a === '--maxPeers') {
      opts.maxPeers = parseInt(args[++i], 10) || opts.maxPeers;
    } else if (a === '--timeout') {
      opts.timeout = parseInt(args[++i], 10) || opts.timeout;
    } else if (a === '--verbose' || a === '-v') {
      opts.verbose = true;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 1) {
    return { help: true };
  }
  opts.txid = positionals[0];
  opts.outfile = positionals[1] || `${opts.txid}.bin`;
  return opts;
}

function usage() {
  console.log(
    `Usage: node ${path.basename(process.argv[1])} <txid> [outfile] [--peers peer1,peer2,...] [--maxPeers N] [--timeout MS] [--verbose]\n`,
  );
  console.log('Example:');
  console.log(
    `  node ${path.basename(process.argv[1])} SIaSQkaJSucywz5Jv5dHQky78Hhur-OEMHn7Jld2ABo bundle.bin --verbose`,
  );
}


// ------------------------------ BASE64URL -----------------------------------
function base64UrlToBuffer(b64url) {
  // Replace URL-safe chars
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  // Pad to multiple of 4
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) b64 += '==='; // unlikely but safe
  return Buffer.from(b64, 'base64');
}

// ------------------------------ PEERS MGMT ----------------------------------
const BUILTIN_PEERS = [
  'https://arweave.net',
  'http://38.29.227.39:1984',
  'http://38.29.227.41:1984',
  'http://165.254.143.21:1984',
];

function normalisePeer(p) {
  let url = p.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    // If includes port assume http
    url = `http://${url}`;
  }
  // Drop trailing slash
  url = url.replace(/\/$/, '');
  return url;
}

async function discoverPeers(seedPeers, timeout, maxPeers, verbose) {
  const visited = new Set();
  const queue = [...seedPeers];
  const out = [];
  while (queue.length && out.length < maxPeers) {
    const peer = queue.shift();
    const norm = normalisePeer(peer);
    if (!norm || visited.has(norm)) continue;
    visited.add(norm);
    out.push(norm);
    if (verbose) console.error(`[peers] visiting ${norm}`);
    try {
      const arr = await axios.get(`${norm}/peers`, { timeout }).then(r => r.data);
      for (const cand of arr) {
        const c = normalisePeer(cand);
        if (
          c &&
          !visited.has(c) &&
          !queue.includes(c) &&
          out.length + queue.length < maxPeers
        ) {
          queue.push(c);
        }
      }
    } catch (err) {
      if (verbose)
        console.error(`[peers] ${norm} /peers failed: ${err.message}`);
    }
  }
  return out.slice(0, maxPeers);
}

// -------------------------- TX OFFSET + SIZE --------------------------------
async function fetchTxOffset(txid, peers, timeout, verbose) {
  const errors = [];
  for (const p of peers) {
    const url = `${p}/tx/${txid}/offset`;
    if (verbose) console.error(`[offset] ${url}`);
    try {
      const json = await axios.get(url, { timeout }).then(r => r.data);
      if (
        json &&
        typeof json.offset !== 'undefined' &&
        typeof json.size !== 'undefined'
      ) {
        return {
          peer: p,
          offset: BigInt(json.offset),
          size: BigInt(json.size),
        };
      }
      errors.push(new Error(`Malformed response from ${p}`));
    } catch (err) {
      errors.push(err);
    }
  }
  const e = new Error(
    `Failed to fetch tx offset from any peer (${errors.length} errors)`,
  );
  e.causes = errors;
  throw e;
}

// ------------------------------ CHUNK FETCH ---------------------------------
async function fetchChunkFromPeer(peer, absPos, timeout, verbose) {
  const url = `${peer}/chunk/${absPos.toString()}`;
  if (verbose) console.error(`[chunk] GET ${url}`);
  const json = await axios.get(url, { timeout }).then(r => r.data);
  if (!json || typeof json.chunk !== 'string') throw new Error('chunk missing');
  const buf = base64UrlToBuffer(json.chunk);
  // Response may include an `offset` (end offset) and/or `data_size`; tolerate absence.
  // If offset provided use it; else assume the chunk we requested ends at absPos + buf.length -1.
  const respEnd =
    json.offset !== undefined
      ? BigInt(json.offset)
      : absPos + BigInt(buf.length) - 1n;
  const chunkStart = respEnd - BigInt(buf.length) + 1n;
  return { buf, start: chunkStart, end: respEnd, raw: json };
}

async function fetchChunk(peers, absPos, timeout, verbose) {
  const errors = [];
  for (const p of peers) {
    try {
      return await fetchChunkFromPeer(p, absPos, timeout, verbose);
    } catch (err) {
      errors.push(err);
      if (verbose) console.error(`[chunk] ${p} failed: ${err.message}`);
    }
  }
  const e = new Error(`All peers failed for chunk @${absPos.toString()}`);
  e.causes = errors;
  throw e;
}

// ------------------------------ MAIN LOGIC ----------------------------------
export async function fetchArweaveChunks(opts, { logger = console.log, errorLogger = console.error } = {}) {
  opts.outfile = opts.outfile || `${opts.txid}.bin`;
  const seed = [...BUILTIN_PEERS, ...(opts.peers || [])];
  // const peers = await discoverPeers(
  //   seed,
  //   opts.timeout,
  //   opts.maxPeers,
  //   opts.verbose,
  // );

  const peers = [
    '38.29.227.39:1984',
    '38.29.227.41:1984',
    '38.29.227.85:1984',
    '165.254.143.21:1984',
    '168.119.211.20:1984',
    '38.29.227.87:1984',
    '38.29.227.43:1984',
    '38.29.227.89:1984',
    '49.12.135.160:1984',
    '108.238.244.144:2012',
    '38.29.227.93:1984',
    '165.254.143.17:1984',
    '165.254.143.25:1984',
    '112.120.10.191:1986',
    '165.254.143.31:1984',
    '38.29.227.91:1984',
    '165.254.143.27:1984',
    '165.254.143.23:1984',
    '38.29.227.95:1984',
    '112.120.10.191:1984',
    '47.205.134.63:1985',
    '74.82.0.180:1995',
    '165.254.143.33:1984',
    '165.254.143.29:1984',
    '138.201.218.229:1984',
    '112.120.10.191:1985',
    '168.119.211.60:1984',
    '165.254.143.19:1984',
    '154.201.1.130:11099',
    '74.82.0.180:1986',
    '3.34.96.164:1984',
    '74.82.0.180:1988',
  ];

  // Normalize and deduplicate all peers
  const allPeers = Array.from(
    new Set([...seed, ...peers].map(normalisePeer).filter(Boolean))
  );
  logger(`Using peers for chunk fetch: [${allPeers.join(', ')}]`);

  const { offset: endOffset, size } = await fetchTxOffset(
    opts.txid,
    allPeers,
    opts.timeout,
    opts.verbose,
  );
  const startOffset = endOffset - size + 1n;
  if (opts.verbose)
    errorLogger(`[tx] size=${size} end=${endOffset} start=${startOffset}`);

  const buffers = [];
  let bytesAccum = 0n;
  let nextPos = startOffset;
  let chunkCount = 0;
  let estTotalChunks = Math.ceil(Number(size) / (256 * 1024)); // estimate
  while (bytesAccum < size) {
    const { buf, start, end } = await fetchChunk(
      allPeers,
      nextPos,
      opts.timeout,
      opts.verbose,
    );
    // Determine slice we need from this chunk.
    // If the chunk starts before the next unread position, slice forward.
    let sliceStart = 0;
    if (start < nextPos) {
      sliceStart = Number(nextPos - start); // safe because <= buf.length
    }
    let usable = buf.slice(sliceStart);
    // Do not read past declared size.
    const remaining = Number(size - bytesAccum);
    if (usable.length > remaining) {
      usable = usable.slice(0, remaining);
    }
    buffers.push(usable);
    bytesAccum += BigInt(usable.length);
    chunkCount++;
    logger(`Fetched chunk ${chunkCount} (size: ${usable.length} bytes, total: ${bytesAccum}/${size})`);
    if (bytesAccum >= size) break;
    // Compute next absolute position (byte index) to request.
    nextPos = start + BigInt(buf.length); // first byte after this chunk
  }

  const outBuf = Buffer.concat(buffers.map((b) => Buffer.from(b)));
  if (BigInt(outBuf.length) !== size) {
    errorLogger(`❌ Failed to fetch all chunks for ${opts.txid}: expected ${size} bytes, got ${outBuf.length} bytes.`);
    throw new Error(
      `Incomplete: expected ${size} bytes but assembled ${outBuf.length}`,
    );
  }
  fs.writeFileSync(opts.outfile, outBuf);
  logger(`✅ Successfully fetched and assembled all chunks for ${opts.txid}!`);
  logger(`Wrote ${outBuf.length} bytes to ${opts.outfile}`);
  return { outfile: path.resolve(opts.outfile), bytes: outBuf.length };
}

// ------------------------------ ENTRYPOINT ----------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let opts;
    try {
      opts = parseArgs(process.argv);
    } catch (err) {
      console.error(err.message);
      usage();
      process.exit(1);
    }
    if (opts.help) {
      usage();
      process.exit(0);
    }
    try {
      const res = await fetchArweaveChunks(opts, { logger: console.log, errorLogger: console.error });
      console.log(`Wrote ${res.bytes} bytes to ${res.outfile}`);
      process.exit(0);
    } catch (err) {
      console.error('ERROR:', err.message);
      if (err.causes) {
        for (const c of err.causes) {
          console.error('  cause:', c.message);
        }
      }
      process.exit(3);
    }
  })();
}
