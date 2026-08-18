// ============================================
// Fake Supabase — browser-side client shim.
//
// Served in place of https://esm.sh/@supabase/supabase-js@2 so the app's real
// modules run untouched. Every operation is forwarded to the Node-side
// FakeStore via window.__dbOp, which is what lets separate browser pages see
// each other's writes.
//
// Exposes window.__fakeChannels so tests can assert on subscription teardown —
// that is how the cleanup() channel leak is detected.
// ============================================

const channels = [];
const subHandlers = new Map();   // subId -> callback

window.__fakeChannels = channels;
window.__rtDispatch = (subId, payload) => {
  const handler = subHandlers.get(subId);
  if (handler) handler(payload);
};
window.__presenceSync = (topic, snapshot) => {
  for (const ch of channels) {
    if (ch.topic !== topic) continue;
    ch._presence = snapshot;
    for (const h of ch._presenceHandlers) {
      if (h.event === 'sync' || !h.event) h.cb();
    }
  }
};
window.__fakeBroadcast = (channelName, event, payload) => {
  for (const ch of channels) {
    if (ch.topic !== channelName || ch.state !== 'joined') continue;
    for (const b of ch._broadcastHandlers) {
      if (b.event === event || b.event === '*') b.cb({ event, payload });
    }
  }
};

class QueryBuilder {
  constructor(table) {
    this.op = { table, action: 'select', payload: null, filters: [], modifiers: {} };
  }
  select(_cols, opts) {
    if (this.op.action === 'select') this.op.action = 'select';
    if (opts && opts.count) this.op.modifiers.count = opts.count;
    return this;
  }
  insert(payload)  { this.op.action = 'insert'; this.op.payload = payload; return this; }
  update(payload)  { this.op.action = 'update'; this.op.payload = payload; return this; }
  delete()         { this.op.action = 'delete'; return this; }
  upsert(payload, opts) {
    this.op.action = 'upsert';
    this.op.payload = payload;
    if (opts?.onConflict) this.op.modifiers.onConflict = opts.onConflict;
    // ON CONFLICT DO NOTHING. The host's blank answer-fill depends on this to
    // avoid overwriting an answer a player submitted at the same moment, so a
    // store that merged regardless would test the opposite of the real client.
    if (opts?.ignoreDuplicates) this.op.modifiers.ignoreDuplicates = true;
    return this;
  }
  eq(c, v)   { this.op.filters.push({ column: c, op: 'eq',  value: v }); return this; }
  neq(c, v)  { this.op.filters.push({ column: c, op: 'neq', value: v }); return this; }
  gt(c, v)   { this.op.filters.push({ column: c, op: 'gt',  value: v }); return this; }
  gte(c, v)  { this.op.filters.push({ column: c, op: 'gte', value: v }); return this; }
  lt(c, v)   { this.op.filters.push({ column: c, op: 'lt',  value: v }); return this; }
  lte(c, v)  { this.op.filters.push({ column: c, op: 'lte', value: v }); return this; }
  is(c, v)   { this.op.filters.push({ column: c, op: 'is',  value: v }); return this; }
  in(c, v)   { this.op.filters.push({ column: c, op: 'in',  value: v }); return this; }
  or(expr)   { this.op.filters.push({ column: null, op: 'or', value: expr }); return this; }
  contains(c, v) { this.op.filters.push({ column: c, op: 'contains', value: v }); return this; }
  like(c, v)  { this.op.filters.push({ column: c, op: 'like',  value: v }); return this; }
  ilike(c, v) { this.op.filters.push({ column: c, op: 'ilike', value: v }); return this; }
  overlaps(c, v) { this.op.filters.push({ column: c, op: 'overlaps', value: v }); return this; }
  not(c, op, v)  { this.op.filters.push({ column: c, op: `not.${op}`, value: v }); return this; }
  order(column, opts = {}) {
    this.op.modifiers.order = { column, ascending: opts.ascending !== false };
    return this;
  }
  limit(n)          { this.op.modifiers.limit = n; return this; }
  range(from, to)   { this.op.modifiers.range = [from, to]; return this; }
  single()          { this.op.modifiers.single = true; return this; }
  maybeSingle()     { this.op.modifiers.maybeSingle = true; return this; }
  abortSignal()     { return this; }

  then(resolve, reject) {
    return window.__dbOp(JSON.parse(JSON.stringify(this.op))).then(resolve, reject);
  }
  catch(fn) { return this.then(r => r).catch(fn); }
}

class FakeChannel {
  constructor(topic) {
    this.topic = topic;
    this.state = 'closed';
    this._pgHandlers = [];
    this._broadcastHandlers = [];
    this._presenceHandlers = [];
    this._subIds = [];
    this._presence = {};
  }
  on(type, a, b) {
    if (type === 'postgres_changes') {
      this._pgHandlers.push({ config: a, cb: b });
    } else if (type === 'broadcast') {
      this._broadcastHandlers.push({ event: a?.event, cb: b });
    } else if (type === 'presence') {
      this._presenceHandlers.push({ event: a?.event, cb: b });
    }
    return this;
  }
  subscribe(cb) {
    this.state = 'joined';
    for (const h of this._pgHandlers) {
      const cfg = h.config || {};
      const events = [cfg.event === '*' || !cfg.event ? '*' : cfg.event];
      window.__dbSubscribe({ table: cfg.table, filter: cfg.filter, events })
        .then(subId => {
          this._subIds.push(subId);
          subHandlers.set(subId, payload => h.cb(payload));
        });
    }
    window.__presenceWatch(this.topic);
    if (cb) setTimeout(() => cb('SUBSCRIBED'), 0);
    return this;
  }
  async track(state) {
    // Goes through the shared store: a per-page object would mean every client
    // only ever sees itself present.
    await window.__presenceTrack(this.topic, window.__robotId || 'self', state);
    return 'ok';
  }
  async untrack() {
    await window.__presenceLeave(this.topic, window.__robotId || 'self');
    return 'ok';
  }
  presenceState() { return this._presence; }
  async send(msg) {
    await window.__dbBroadcast(this.topic, msg.event, msg.payload);
    return 'ok';
  }
  unsubscribe() {
    this.state = 'closed';
    for (const id of this._subIds) {
      window.__dbUnsubscribe(id);
      subHandlers.delete(id);
    }
    this._subIds = [];
    const i = channels.indexOf(this);
    if (i !== -1) channels.splice(i, 1);
    return Promise.resolve('ok');
  }
}

export function createClient(_url, _key) {
  return {
    from: (table) => new QueryBuilder(table),
    rpc: (name, args) => window.__dbOp({ table: name, action: 'rpc', payload: args, filters: [], modifiers: {} }),
    channel: (topic) => {
      const ch = new FakeChannel(topic);
      channels.push(ch);
      return ch;
    },
    removeChannel: (ch) => (ch && ch.unsubscribe ? ch.unsubscribe() : Promise.resolve('ok')),
    getChannels: () => channels,
    auth: {
      getSession: async () => ({ data: { session: window.__fakeSession || null }, error: null }),
      getUser:    async () => ({ data: { user: window.__fakeSession?.user || null }, error: null }),
      signUp:     async () => ({ data: { user: null, session: null }, error: { message: 'not supported in tests' } }),
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: 'not supported in tests' } }),
      // Real OAuth leaves the page for Google, which a robot cannot follow.
      // Returning an error keeps the button's failure path honest rather than
      // throwing "signInWithOAuth is not a function" and looking like a crash.
      signInWithOAuth: async () => ({ data: { provider: 'google', url: null }, error: { message: 'OAuth not supported in tests' } }),
      signOut:    async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
}

export default { createClient };
