import express from 'express';
import cors from 'cors';
import { fixArweaveTx } from './fix.mjs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// /fix endpoint streams logs as text/plain to the client in real time, concurrency-safe
app.post('/fix', async (req, res) => {
  const { txid } = req.body;
  if (!txid) {
    res.status(400).type('text').end('Missing txid\n');
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Per-request logger functions
  const logger = (...args) => {
    const msg = args.join(' ') + '\n';
    res.write(msg);
    process.stdout.write(msg);
  };
  const errorLogger = (...args) => {
    const msg = args.join(' ') + '\n';
    res.write(msg);
    process.stderr.write(msg);
  };

  try {
    const result = await fixArweaveTx(txid, { logger, errorLogger });
    res.write('\nDONE: ' + JSON.stringify(result) + '\n');
    res.end();
  } catch (e) {
    res.write('\nERROR: ' + e.message + '\n');
    res.end();
  }
});

export { app };

if ((typeof require !== 'undefined' && require.main === module) || process.env.LOCAL_DEV) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backfill-from-Irys API listening on port ${PORT}`);
  });
}
