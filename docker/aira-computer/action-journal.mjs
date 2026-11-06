import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// One runner per owner/volume. Persistent STARTED receipts are intentionally not
// retried after a crash: arbitrary external effects cannot be rolled back.
export function createActionJournal(root, secret) {
  let tail = Promise.resolve();
  const id = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid action ID.');
    return value;
  };
  async function read(name) {
    try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function persist(name, value) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, name);
    const temporary = target + '.tmp';
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, target);
    // Linux deployment volumes require the directory entry to be durable too.
    if (process.platform !== 'win32') {
      const directory = await fs.open(root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async function lock() {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  const receipt = actionId => read(id(actionId) + '.json');
  async function revoke(actionId) {
    const release = await lock();
    try { await persist(id(actionId) + '.json', { status: 'ABANDONED', revoked: true }); }
    finally { release(); }
  }
  async function middleware(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    let identity;
    try {
      const encoded = req.headers['x-aira-action'];
      const signature = req.headers['x-aira-action-signature'];
      if (typeof encoded !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Signed action authority is required.');
      const expected = createHmac('sha256', secret).update(encoded).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid action signature.');
      identity = JSON.parse(encoded);
      id(identity.id);
      const digest = createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
      if (identity.method !== req.method || identity.route !== req.path || identity.digest !== digest ||
        !Number.isSafeInteger(identity.fence) || identity.fence < 1 || !Number.isSafeInteger(identity.expiresAt)) throw new Error('Action authority does not match the request.');
    } catch (error) { return res.status(403).json({ error: error.message }); }
    const release = await lock();
    const reply = res.json.bind(res);
    try {
      const previous = await receipt(identity.id);
      if (previous) {
        release();
        if (previous.digest !== identity.digest || previous.route !== identity.route || previous.method !== identity.method) return res.status(409).json({ error: 'ACTION_ID_CONFLICT' });
        if (previous.status !== 'COMPLETED') return res.status(409).json({ error: 'COMPUTER_ACTION_UNCERTAIN' });
        return res.status(previous.httpStatus).json(previous.result);
      }
      const highWater = await read('fence.json');
      if (identity.expiresAt <= Date.now() || identity.fence < (highWater?.fence || 0) ||
        (identity.fence === highWater?.fence && identity.token !== highWater.token)) {
        release();
        return res.status(409).json({ error: 'COMPUTER_LEASE_LOST' });
      }
      await persist('fence.json', { fence: identity.fence, token: identity.token });
      await persist(identity.id + '.json', { status: 'STARTED', digest: identity.digest, route: identity.route, method: identity.method });
      res.json = value => {
        void (async () => {
          try {
            await persist(identity.id + '.json', {
              status: 'COMPLETED', digest: identity.digest, route: identity.route, method: identity.method,
              httpStatus: res.statusCode, result: value, error: res.statusCode >= 400 ? value?.error : undefined
            });
            reply(value);
          } catch (error) { res.status(503); reply({ error: 'Action result could not be persisted: ' + error.message }); }
          finally { release(); }
        })();
        return res;
      };
      next();
    } catch (error) { release(); res.status(503); reply({ error: error.message }); }
  }
  return { middleware, receipt, revoke };
}
