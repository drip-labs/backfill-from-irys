import express from 'express';
import cors from 'cors';
import { fixArweaveTx } from './fix.mjs';

// Helper to require env vars


const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// /fix endpoint streams logs as text/plain to the client in real time
app.post('/fix', async (req, res) => {
  const { txid } = req.body;
  if (!txid) {
    res.status(400).type('text').end('Missing txid\n');
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Patch console.log and console.error to stream to the response
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => {
    const msg = args.join(' ') + '\n';
    res.write(msg);
    origLog.apply(console, args);
  };
  console.error = (...args) => {
    const msg = args.join(' ') + '\n';
    res.write(msg);
    origError.apply(console, args);
  };

  try {
    const result = await fixArweaveTx(txid);
    res.write('\nDONE: ' + JSON.stringify(result) + '\n');
    res.end();
  } catch (e) {
    res.write('\nERROR: ' + e.message + '\n');
    res.end();
  } finally {
    // Restore original console methods
    console.log = origLog;
    console.error = origError;
  }
});

export { app };

if ((typeof require !== 'undefined' && require.main === module) || process.env.LOCAL_DEV) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backfill-from-Irys API listening on port ${PORT}`);
  });
} 