// ============================================
// Fake Supabase — shared in-memory store (Node side)
//
// Backs the browser-side client shim. One store is shared by every robot's
// browser page, which is what makes them see each other.
//
// Faithfulness notes (these matter — the real bugs live in these details):
//   * DELETE events carry ONLY the primary key in `old`. Postgres' default
//     REPLICA IDENTITY sends nothing else, and js/game/phases.js explicitly
//     works around this. A fake that sent the whole row would let broken code
//     pass here and fail in production.
//   * Events are delivered asynchronously, never inside the caller's own
//     await. Synchronous delivery would hide ordering races.
//   * A client receives events for its OWN writes, exactly like Realtime.
//   * AN RPC THAT CHANGES A ROW BROADCASTS IT. An UPDATE inside a Postgres
//     function reaches Realtime exactly like one from a client — it is in the
//     WAL either way — so a fake that mutated rows silently leaves every other
//     phone unaware. Moving the clock stamp into a function made scenario-nasty
//     report "the room is stuck" and the app was right; the store was wrong.
//     Any new RPC that touches rooms, players, answers or chat_messages must
//     call _broadcast, or it will look like the app has stopped listening.
// ============================================

// The game is moving off the host's phone, and the fake store has to be able to
// stand in for the database functions doing it — otherwise every scenario
// silently exercises the client-side fallback and the new path ships untested.
//
// fuzzyMatch is imported rather than reimplemented, because a fake judge that
// disagreed with the real one would report bugs that do not exist. The SQL is
// held to the same rule from the other side: scripts/verify-sql.mjs runs
// thousands of cases through op_answer_matches AND this same function.
//
// js/utils.js registers online/offline listeners at import time, so it needs a
// window to register them on before it will load in bare Node.
const _noop = () => {};
globalThis.window ??= { addEventListener: _noop, removeEventListener: _noop };
globalThis.document ??= { body: { classList: { remove: _noop }, style: {} }, addEventListener: _noop };
const { fuzzyMatch } = await import('../../js/utils.js');

let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

// Tables whose real primary key is BIGINT GENERATED ALWAYS AS IDENTITY, not a
// uuid. Handing these a uuid is not a harmless difference: profile.js accepts a
// friend request with parseInt(btn.dataset.accept, 10), which turns a uuid into
// NaN, so accepting silently matched no row. The app was right and this store
// was wrong, and it would have been reported as a bug in the friends feature.
const INTEGER_PK = new Set(['friend_requests']);
let nextIntId = 1;
const newId = table => (INTEGER_PK.has(table) ? nextIntId++ : uuid());

export class FakeStore {
  constructor() {
    this.tables = new Map();       // name -> array of row objects
    this._denied = new Set();      // tables whose writes are refused, RLS-style
    this._slowReads = new Map();   // table -> extra ms, for forcing a race to lose
    this._dropEvents = new Map();  // table -> how many realtime events to swallow
    this._missing = new Set();     // tables that answer as if they do not exist
    this._checks = new Map();      // table -> [{ predicate, name }], simulating CHECK constraints
    this.subscribers = [];         // { id, table, filter, events, deliver }
    this.log = [];                 // every operation, for assertions
    this.presence = new Map();     // topic -> Map(robotId -> state)
    this.presenceWatchers = [];    // { topic, deliver }
    this.latencyMs = 0;            // artificial delay, set per scenario
    this.eventDelayMs = 0;         // artificial realtime lag
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  /**
   * Refuse rows a predicate rejects, the way a CHECK constraint does: error
   * 23514, and nothing written.
   *
   * This exists because the live `friendships` table turned out to carry a
   * constraint that appears in NO migration in this repo and that rejected the
   * only `source` value any caller passes. Every accept of a friend request
   * died on it, and no scenario could see that, because the fake store happily
   * accepted any row at all. A store that never refuses cannot test code whose
   * job is to survive a refusal.
   */
  addCheck(table, predicate, name = 'check') {
    if (!this._checks.has(table)) this._checks.set(table, []);
    this._checks.get(table).push({ predicate, name });
  }
  /** Remove every simulated CHECK on a table. */
  clearChecks(table) { this._checks.delete(table); }

  /**
   * Make reads of one table slow, so a race can be forced to lose.
   *
   * `latencyMs` is global and therefore useless for this: delaying everything
   * equally preserves whatever order the code already had. A race is only
   * testable once the LOSING order is forced explicitly — the lobby loaded its
   * player list and its chat history concurrently, and every scenario happened
   * to schedule the players first, so the bug that reached a live game was
   * invisible here by luck rather than by design.
   */
  slowReads(table, ms) { this._slowReads.set(table, ms); }
  /** Undo slowReads. */
  normalReads(table) { this._slowReads.delete(table); }

  /**
   * Silently drop the next N Realtime events for a table, the way a real
   * connection does when it hiccups.
   *
   * The app's whole design assumes this happens — syncToCurrentState exists as
   * the safety net for it — but no scenario had ever made it happen, so the net
   * was never tested and turned out to have a hole. A player received a
   * completely different final question from everybody else because the one
   * update carrying the new question list went missing and nothing re-checked
   * the list afterwards.
   */
  dropEvents(table, count) { this._dropEvents.set(table, count); }

  /** Refuse every write to `table`, the way an RLS policy does: zero rows, no error. */
  denyWrites(table) { this._denied.add(table); }
  /** Undo denyWrites. */
  allowWrites(table) { this._denied.delete(table); }

  /**
   * Make `table` behave as if it does not exist, the way PostgREST does:
   * an ERROR with code PGRST205, not an empty list.
   *
   * The difference is the whole point. An unseeded table in this store returns
   * [] with no error, which is what a real EMPTY table does — so a code path
   * that falls back when a relation is missing could never be reached here,
   * and the fallback would ship untested. player_stats_computed was absent
   * from the live database for months answering exactly this error while every
   * scenario saw a harmless empty array.
   */
  denyReads(table) { this._missing.add(table); }
  /** Undo denyReads. */
  allowReads(table) { this._missing.delete(table); }

  seed(name, rows) {
    this.table(name).push(...rows.map(r => ({ ...r })));
  }

  // --- subscriptions ---------------------------------------------------

  subscribe({ table, filter, events, deliver }) {
    const id = `sub_${this.subscribers.length + 1}`;
    this.subscribers.push({ id, table, filter, events, deliver, active: true });
    return id;
  }

  unsubscribe(id) {
    const sub = this.subscribers.find(s => s.id === id);
    if (sub) sub.active = false;
  }

  /** Subscriptions still live — the leak detector reads this. */
  activeSubscriptions() {
    return this.subscribers.filter(s => s.active);
  }

  _matchesFilter(row, filter) {
    if (!filter) return true;
    // Realtime filters look like "room_id=eq.<uuid>"
    const m = /^(\w+)=eq\.(.*)$/.exec(filter);
    if (!m) return true;
    return String(row?.[m[1]]) === String(m[2]);
  }

  _broadcast(eventType, table, newRow, oldRow) {
    // Postgres sends only the primary key for DELETE (default REPLICA IDENTITY).
    const payloadOld = eventType === 'DELETE' && oldRow ? { id: oldRow.id } : oldRow;
    const toDrop = this._dropEvents.get(table) || 0;
    if (toDrop > 0) {
      this._dropEvents.set(table, toDrop - 1);
      return;   // the connection hiccuped; nobody hears about this one
    }
    const targets = this.subscribers.filter(s =>
      s.active &&
      s.table === table &&
      (s.events.includes('*') || s.events.includes(eventType))
    );
    for (const sub of targets) {
      // DELETE filters cannot match, because the payload has no columns beyond
      // the primary key — the real service behaves the same way, which is why
      // the app needs its fallback polling.
      const rowForFilter = eventType === 'DELETE' ? null : (newRow || oldRow);
      if (eventType !== 'DELETE' && !this._matchesFilter(rowForFilter, sub.filter)) continue;
      const payload = {
        eventType,
        new: newRow ? { ...newRow } : null,
        old: payloadOld ? { ...payloadOld } : null,
        table,
      };
      setTimeout(() => { if (sub.active) sub.deliver(payload); }, this.eventDelayMs);
    }
  }

  // --- presence ---------------------------------------------------------
  //
  // Presence must be shared across pages or every client sees only itself,
  // which silently disables anything driven by it — the away indicator and the
  // staleness check both read it.

  presenceTrack(topic, robotId, state) {
    if (!this.presence.has(topic)) this.presence.set(topic, new Map());
    this.presence.get(topic).set(robotId, state);
    this._presenceSync(topic);
  }

  presenceLeave(topic, robotId) {
    this.presence.get(topic)?.delete(robotId);
    this._presenceSync(topic);
  }

  presenceState(topic) {
    const out = {};
    for (const [id, st] of (this.presence.get(topic) || new Map())) out[id] = [st];
    return out;
  }

  watchPresence(topic, deliver) {
    this.presenceWatchers.push({ topic, deliver, active: true });
  }

  _presenceSync(topic) {
    const snapshot = this.presenceState(topic);
    for (const w of this.presenceWatchers) {
      if (w.active && w.topic === topic) setTimeout(() => w.deliver(snapshot), this.eventDelayMs);
    }
  }

  // --- query execution -------------------------------------------------

  _applyFilters(rows, filters) {
    return rows.filter(row => filters.every(f => {
      const val = row[f.column];
      switch (f.op) {
        case 'eq':  return String(val) === String(f.value);
        case 'neq': return String(val) !== String(f.value);
        case 'gt':  return val > f.value;
        case 'gte': return val >= f.value;
        case 'lt':  return val < f.value;
        case 'lte': return val <= f.value;
        case 'is':  return f.value === null ? (val === null || val === undefined) : val === f.value;
        case 'in':  return f.value.map(String).includes(String(val));
        case 'contains':
          return Array.isArray(val) && f.value.every(v => val.includes(v));
        case 'overlaps':
          return Array.isArray(val) && f.value.some(v => val.includes(v));
        case 'like':
        case 'ilike': {
          const rx = new RegExp(
            '^' + String(f.value)
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/%/g, '.*')
              .replace(/_/g, '.') + '$',
            f.op === 'ilike' ? 'i' : ''
          );
          return rx.test(String(val ?? ''));
        }
        case 'or': {
          // "a.eq.1,b.eq.2"
          return f.value.split(',').some(clause => {
            const [col, op, ...rest] = clause.split('.');
            const target = rest.join('.');
            if (op === 'eq') return String(row[col]) === target;
            return false;
          });
        }
        default: return true;
      }
    }));
  }

  async execute(op) {
    if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs));
    this.log.push(op);

    const { table, action, payload, filters = [], modifiers = {} } = op;
    const rows = this.table(table);

    // Per-table delay, for forcing a race to lose. See slowReads().
    const slow = this._slowReads.get(table);
    if (slow && action === 'select') await new Promise(r => setTimeout(r, slow));

    // Simulate an RLS refusal, which is the single most misleading thing this
    // database does: a policy that denies a write does NOT return an error. The
    // statement succeeds and affects zero rows, so `if (error)` is false and the
    // caller reports success while nothing was saved. That is how the admin page
    // said "Saved!" for months without saving anything.
    //
    // denyWrites('questions') makes this store behave the same way, so the code
    // paths that are supposed to notice can actually be tested.
    if (this._denied.has(table) && action !== 'select') {
      return modifiers.single
        ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
        : { data: [], error: null, count: 0 };
    }

    // A relation PostgREST cannot find. Applies to reads and writes alike, and
    // is checked before anything else, because a missing table cannot filter,
    // order or count.
    if (this._missing.has(table)) {
      const err = {
        message: `Could not find the table 'public.${table}' in the schema cache`,
        code: 'PGRST205',
      };
      return modifiers.single || modifiers.maybeSingle
        ? { data: null, error: err }
        : { data: null, error: err };
    }

    try {
      if (action === 'select') {
        let result = this._applyFilters(rows, filters).map(r => ({ ...r }));
        if (modifiers.order) {
          const { column, ascending } = modifiers.order;
          result.sort((a, b) => {
            if (a[column] === b[column]) return 0;
            const cmp = a[column] > b[column] ? 1 : -1;
            return ascending === false ? -cmp : cmp;
          });
        }
        if (modifiers.range) result = result.slice(modifiers.range[0], modifiers.range[1] + 1);
        if (modifiers.limit != null) result = result.slice(0, modifiers.limit);
        if (modifiers.single) {
          if (result.length !== 1) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
          }
          return { data: result[0], error: null };
        }
        if (modifiers.maybeSingle) {
          // maybeSingle tolerates ZERO rows and nothing else. PostgREST errors
          // on more than one, exactly as .single() does — the "maybe" is about
          // absence, not about multiplicity.
          //
          // The shim used to return the first row instead, and that hid a real
          // bug for as long as this harness has existed: two guards in
          // sendFriendRequest used maybeSingle on a lookup that was not
          // actually unique, discarded the error, and so failed OPEN on live
          // data that had duplicate rows. Every scenario passed. The owner's
          // own account has three rows for one pair because of it.
          if (result.length > 1) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${result.length} rows` } };
          }
          return { data: result[0] ?? null, error: null };
        }
        return { data: result, error: null, count: result.length };
      }

      if (action === 'insert') {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const created = [];
        for (const item of incoming) {
          // Unique room codes, so the app's 23505 retry path stays reachable.
          if (table === 'rooms' && item.code && rows.some(r => r.code === item.code)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          const row = { id: newId(table), created_at: new Date().toISOString(), ...item };
          // CHECK constraints, evaluated on the row as it would be stored.
          // Postgres refuses the WHOLE statement on the first violation and
          // writes nothing, so this returns before anything is pushed.
          const failed = (this._checks.get(table) || []).find(c => !c.predicate(row));
          if (failed) {
            return { data: null, error: {
              code: '23514',
              message: `new row for relation "${table}" violates check constraint "${failed.name}"`,
            } };
          }
          rows.push(row);
          created.push(row);
          this._broadcast('INSERT', table, row, null);
        }
        if (modifiers.single) return { data: { ...created[0] }, error: null };
        return { data: created.map(r => ({ ...r })), error: null };
      }

      if (action === 'update') {
        const targets = this._applyFilters(rows, filters);
        const updated = [];
        for (const row of targets) {
          const before = { ...row };
          Object.assign(row, payload);
          updated.push({ ...row });
          this._broadcast('UPDATE', table, { ...row }, before);
        }
        if (modifiers.single) {
          if (updated.length !== 1) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
          return { data: updated[0], error: null };
        }
        return { data: updated, error: null };
      }

      if (action === 'upsert') {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const keys = (modifiers.onConflict || 'id').split(',').map(s => s.trim());
        const result = [];
        for (const item of incoming) {
          const existing = rows.find(r => keys.every(k => String(r[k]) === String(item[k])));
          if (existing && modifiers.ignoreDuplicates) {
            // ON CONFLICT DO NOTHING — leave the existing row untouched and
            // emit nothing, exactly as Postgres does.
            continue;
          }
          if (existing) {
            const before = { ...existing };
            Object.assign(existing, item);
            result.push({ ...existing });
            this._broadcast('UPDATE', table, { ...existing }, before);
          } else {
            const row = { id: newId(table), created_at: new Date().toISOString(), ...item };
            rows.push(row);
            result.push({ ...row });
            this._broadcast('INSERT', table, row, null);
          }
        }
        if (modifiers.single) return { data: result[0], error: null };
        return { data: result, error: null };
      }

      if (action === 'delete') {
        const targets = this._applyFilters(rows, filters);
        for (const row of targets) {
          const idx = rows.indexOf(row);
          if (idx !== -1) rows.splice(idx, 1);
          this._broadcast('DELETE', table, null, row);
        }
        return { data: targets.map(r => ({ ...r })), error: null };
      }

      if (action === 'rpc') {
        return { data: this._rpc(table, payload), error: null };
      }

      return { data: null, error: { message: `unsupported action ${action}` } };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  _rpc(name, args) {
    if (name === 'increment_questions_answered') {
      const row = this.table('game_plays').find(r =>
        String(r.room_id) === String(args.p_room_id) &&
        String(r.player_id) === String(args.p_player_id));
      if (row) row.questions_answered = (row.questions_answered || 0) + 1;
      return null;
    }
    // Mirrors migration 034: one record per person per room, counting ROUNDS.
    // Idempotent on p_game_key, so calling it twice for the same round counts
    // once — the caller fires from a phase transition that can repeat.
    // Mirrors migration 035. Takes no arguments there and none here: the
    // function reads auth.uid() itself, so it can only ever delete the caller.
    // The harness passes the signed-in user through the shim's session.
    if (name === 'delete_my_account') {
      const uid = args?.__callerUserId ?? null;
      if (!uid) return null;
      const purge = (tbl, pred) => {
        const rows = this.table(tbl);
        for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) rows.splice(i, 1);
      };
      purge('question_feedback', r => r.voter_id === `user:${uid}`);
      purge('title_unlocks', r => String(r.user_id) === String(uid));
      purge('question_history', r => String(r.user_id) === String(uid));
      purge('game_history', r => String(r.user_id) === String(uid));
      purge('player_stats', r => String(r.user_id) === String(uid));
      purge('player_stats_computed', r => String(r.user_id) === String(uid));
      purge('friend_requests', r => String(r.sender_id) === String(uid) || String(r.receiver_id) === String(uid));
      purge('friendships', r => String(r.user_a) === String(uid) || String(r.user_b) === String(uid));
      purge('profiles', r => String(r.user_id) === String(uid));
      return null;
    }

    if (name === 'record_game_play') {
      const rows = this.table('game_plays');
      const existing = rows.find(r =>
        String(r.room_id) === String(args.p_room_id) &&
        String(r.player_id) === String(args.p_player_id));
      const isNewRound = !existing || existing.last_game_key !== args.p_game_key;
      if (!existing) {
        rows.push({
          id: newId('game_plays'),
          room_id: args.p_room_id, player_id: args.p_player_id,
          player_name: args.p_player_name, category: args.p_category,
          subcategory: args.p_subcategory, total_questions: args.p_total_questions,
          questions_answered: 0, started_at: new Date().toISOString(),
          completed: false, games_played: 1, last_game_key: args.p_game_key,
        });
      } else {
        existing.player_name = args.p_player_name;
        existing.category = args.p_category;
        existing.subcategory = args.p_subcategory;
        existing.total_questions = args.p_total_questions;
        if (isNewRound) {
          existing.questions_answered = 0;
          existing.completed = false;
          existing.games_played = (existing.games_played || 0) + 1;
        }
        existing.last_game_key = args.p_game_key;
      }
      return null;
    }

    // Counts rounds, not records — see record_game_play above.
    if (name === 'get_category_play_counts') {
      const byCat = new Map();
      const bySub = new Map();
      for (const r of this.table('game_plays')) {
        if (!r.category) continue;
        byCat.set(r.category, (byCat.get(r.category) || 0) + (r.games_played || 0));
        if (r.subcategory) {
          const key = `${r.category}|${r.subcategory}`;
          bySub.set(key, (bySub.get(key) || 0) + (r.games_played || 0));
        }
      }
      const out = [];
      for (const [category, play_count] of byCat) out.push({ category, subcategory: null, play_count });
      for (const [key, play_count] of bySub) {
        const [category, subcategory] = key.split('|');
        out.push({ category, subcategory, play_count });
      }
      return out;
    }

    // Mirrors migration 042. The real one reads auth.users, which no client
    // can see; the fake store has no auth schema, so a scenario can check that
    // the panel ASKS for the details and copes when they are unavailable.
    if (name === 'admin_account_details') {
      const p = this.table('profiles').find(r => String(r.user_id) === String(args?.p_user_id));
      if (!p) return [];
      return [{
        email: `${String(p.display_name || 'someone').toLowerCase().replace(/[^a-z0-9]/g, '')}@example.com`,
        provider: 'email',
        email_confirmed: true,
        last_sign_in_at: new Date().toISOString(),
        signed_up_at: p.created_at || new Date().toISOString(),
      }];
    }

    // Mirrors migration 041. The real ones are SECURITY DEFINER because
    // question_history is scoped to its owner, so a host correcting somebody
    // else's answer is refused outright — the whole reason these exist. The
    // fake store has no RLS, so what a scenario can prove here is that the app
    // GOES THROUGH the function rather than writing the table directly; the
    // permission itself is the migration's business.
    if (name === 'amend_question_history') {
      const rows = this.table('question_history');
      const row = rows.find(r =>
        String(r.user_id) === String(args?.p_user_id) &&
        String(r.question_id) === String(args?.p_question_id));
      if (!row) return null;
      if (!!row.last_correct === !!args?.p_is_correct) return null;
      const delta = args?.p_is_correct ? 1 : -1;
      row.times_correct = Math.max(0, Math.min(row.times_seen, (row.times_correct || 0) + delta));
      row.last_correct = !!args?.p_is_correct;
      return null;
    }

    if (name === 'revoke_question_history') {
      const rows = this.table('question_history');
      const i = rows.findIndex(r =>
        String(r.user_id) === String(args?.p_user_id) &&
        String(r.question_id) === String(args?.p_question_id));
      if (i === -1) return null;
      const row = rows[i];
      const nextSeen = (row.times_seen || 0) - 1;
      const nextCorrect = Math.max(0, (row.times_correct || 0) - (row.last_correct ? 1 : 0));
      if (nextSeen <= 0) { rows.splice(i, 1); return null; }
      row.times_seen = nextSeen;
      row.times_correct = nextCorrect;
      row.last_correct = nextCorrect > 0;
      return null;
    }

    // Mirrors migration 043: record one round's history for everybody, once.
    //
    // The real one is SECURITY DEFINER because question_history is scoped to
    // its owner, so no browser can write another player's row. What a scenario
    // can prove here is the two things that are the app's business rather than
    // the migration's: that a player who never touched their phone is recorded
    // at all, and that calling it repeatedly — which Realtime makes likely —
    // counts the round exactly once.
    if (name === 'record_round_history') {
      if (!args?.p_room_id || !args?.p_question_id) return 0;
      const answers = this.table('answers').filter(a =>
        String(a.room_id) === String(args.p_room_id) &&
        String(a.question_id) === String(args.p_question_id) &&
        !a.history_recorded);

      // The marker is claimed FIRST, exactly as the SQL does it, so a second
      // call finds nothing left even if the first is still in flight.
      for (const a of answers) a.history_recorded = true;

      const players = this.table('players');
      const seen = new Set();
      let recorded = 0;
      // Newest answer row wins, matching the SQL's DISTINCT ON ... ORDER BY id
      // DESC — one person can hold two rows through a rejoin.
      for (const a of [...answers].reverse()) {
        const player = players.find(p => String(p.id) === String(a.player_id));
        if (!player || !player.user_id || player.is_bot) continue;
        if (seen.has(String(player.user_id))) continue;
        seen.add(String(player.user_id));

        const rows = this.table('question_history');
        const isCorrect = !!a.is_correct;
        const row = rows.find(r =>
          String(r.user_id) === String(player.user_id) &&
          String(r.question_id) === String(args.p_question_id));
        if (row) {
          row.times_seen = (row.times_seen || 0) + 1;
          row.times_correct = (row.times_correct || 0) + (isCorrect ? 1 : 0);
          row.last_correct = isCorrect;
          row.last_seen_at = new Date().toISOString();
        } else {
          rows.push({
            user_id: player.user_id, question_id: args.p_question_id,
            times_seen: 1, times_correct: isCorrect ? 1 : 0,
            last_correct: isCorrect, last_seen_at: new Date().toISOString(),
          });
        }
        recorded++;
      }
      return recorded;
    }

    // ---- migration 049: only a host changes a verdict ----------------------
    //
    // The POINTS are recomputed from the answer's own wager, never taken from
    // the caller — that is the difference the migration exists to make.
    if (name === 'op_set_judgement' || name === 'op_disqualify_round') {
      const players = this.table('players');
      const answers = this.table('answers');
      const isHost = (roomId, playerId) => players.some(p =>
        String(p.id) === String(playerId) && String(p.room_id) === String(roomId)
        && (p.is_host || p.is_cohost));

      if (name === 'op_disqualify_round') {
        if (!isHost(args?.p_room_id, args?.p_caller_id)) return -1;
        let n = 0;
        for (const a of answers) {
          if (String(a.room_id) !== String(args.p_room_id)) continue;
          if (a.question_number !== args.p_question_number) continue;
          const before = { ...a };
          a.is_correct = false; a.score_earned = 0;
          this._broadcast('UPDATE', 'answers', { ...a }, before);
          n++;
        }
        return n;
      }

      const a = answers.find(x => String(x.id) === String(args?.p_answer_id));
      if (!a) return 'no such answer';
      if (!isHost(a.room_id, args?.p_caller_id)) return 'not the host';
      const room = this.table('rooms').find(r => String(r.id) === String(a.room_id));
      if (!room) return 'no such room';
      const ids = room.question_ids || [];
      const total = Math.max(1, (ids.length ? ids.length - 1 : room.questions_per_game) || 10);
      const isFinal = a.question_number >= total;
      const before = { ...a };
      a.is_correct = !!args.p_is_correct;
      a.score_earned = args.p_is_correct ? (a.wager || 0) : (isFinal ? -(a.wager || 0) : 0);
      // auto_correct is deliberately untouched — it holds the machine's
      // original verdict and is how a bad answer key gets spotted later.
      this._broadcast('UPDATE', 'answers', { ...a }, before);
      return 'changed';
    }

    // ---- migration 048: only the rules delete a room -----------------------
    //
    // Removes the player and takes the room only if no HUMAN is left. A bot
    // never keeps a room alive. Both deletions broadcast, because a client
    // listening for its room disappearing is how everybody else finds out.
    if (name === 'op_leave_room') {
      const rooms = this.table('rooms');
      const players = this.table('players');
      const roomIdx = rooms.findIndex(r => String(r.id) === String(args?.p_room_id));
      if (roomIdx === -1) return 'room deleted';

      if (args?.p_player_id != null) {
        const i = players.findIndex(p => String(p.id) === String(args.p_player_id)
          && String(p.room_id) === String(args.p_room_id));
        if (i !== -1) {
          const [gone] = players.splice(i, 1);
          this._broadcast('DELETE', 'players', null, gone);
        }
      }

      const humansLeft = players.some(p => String(p.room_id) === String(args.p_room_id)
        && !p.is_bot && String(p.id) !== String(args?.p_player_id));
      if (humansLeft) return 'left';

      const [goneRoom] = rooms.splice(roomIdx, 1);
      this._broadcast('DELETE', 'rooms', null, goneRoom);
      return 'room deleted';
    }

    if (name === 'op_sweep_rooms') {
      const rooms = this.table('rooms');
      const players = this.table('players');
      const cutoff = Date.now() - 20 * 60 * 1000;
      const twoHours = Date.now() - 2 * 60 * 60 * 1000;
      let gone = 0;
      for (let i = rooms.length - 1; i >= 0; i--) {
        const r = rooms[i];
        const mine = players.filter(p => String(p.room_id) === String(r.id));
        const humans = mine.filter(p => !p.is_bot);
        // No player rows at all; a lobby nobody started; or every human silent
        // for twenty minutes. A human with no last_seen_at means CANNOT TELL
        // and protects the room.
        const empty = mine.length === 0;
        const staleLobby = r.status === 'lobby' && new Date(r.created_at || 0).getTime() < twoHours;
        const abandoned = humans.length > 0 && humans.every(p =>
          p.last_seen_at && new Date(p.last_seen_at).getTime() <= cutoff);
        if (empty || staleLobby || abandoned) {
          const [goneRoom] = rooms.splice(i, 1);
          this._broadcast('DELETE', 'rooms', null, goneRoom);
          gone++;
        }
      }
      return gone;
    }

    // ---- migration 047: the server owns the clock --------------------------
    //
    // Refuses a caller whose idea of the phase or question is behind the room's,
    // so a host on a slow connection cannot reset a timer everybody else is
    // already partway through. Returns the stamp actually in force either way.
    if (name === 'op_start_clock') {
      const room = this.table('rooms').find(r => String(r.id) === String(args?.p_room_id));
      if (!room) return null;
      const onPhase = room.game_phase === args.p_phase;
      const onQuestion = args.p_question_number == null
        || room.current_question === args.p_question_number;
      // Nothing stamped means NULL, never the stamp already on the room — the
      // caller cannot tell that from its own round's clock, and adopting the
      // last round's start made a 20-second final wager open already expired.
      if (!(onPhase && onQuestion)) return null;
      {
        const before = { ...room };
        room.question_started_at = new Date().toISOString();
        // AND TELL EVERYBODY. An UPDATE inside a Postgres function reaches
        // Realtime like any other — it is in the WAL — so a fake that mutated
        // the row silently would leave every other phone waiting forever. That
        // is not hypothetical: moving the clock stamp into this function made
        // scenario-nasty report "the room is stuck", and the app was right.
        this._broadcast('UPDATE', 'rooms', { ...room }, before);
      }
      return room.question_started_at ?? null;
    }

    if (name === 'op_server_now') return new Date().toISOString();

    // ---- migration 046: the server judges and records ----------------------
    //
    // A mirror of op_submit_answer / op_fill_blank_answers. The point of having
    // it here is NOT to re-test the SQL — verify-sql.mjs does that against a
    // real Postgres — but to make the scenarios exercise the path the app now
    // takes. An unimplemented RPC answers null with no error, which the client
    // correctly falls back from, so without this every robot would keep
    // testing the old client-side route and the new one would ship unplayed.
    if (name === 'op_submit_answer' || name === 'op_fill_blank_answers') {
      const room = this.table('rooms').find(r => String(r.id) === String(args?.p_room_id));
      if (!room) {
        return name === 'op_submit_answer'
          ? [{ is_correct: false, score_earned: 0, wager: null, question_id: null, rejected: 'no such room' }]
          : 0;
      }
      const ids = room.question_ids || [];
      const total = Math.max(1, (ids.length ? ids.length - 1 : room.questions_per_game) || 10);
      const qnum = Number(args.p_question_number);
      const isFinal = qnum >= total;
      const qid = ids[qnum] ?? null;

      // op_next_wager: the player's lowest unspent value, skipping the final
      // round's own wager space and the __WAGER_LOCKED__ placeholder.
      const nextWager = (playerId) => {
        const spent = new Set(this.table('answers')
          .filter(a => String(a.room_id) === String(room.id)
            && String(a.player_id) === String(playerId)
            && a.question_number < total
            && a.wager != null
            && String(a.submitted_answer || '').trim() !== '__WAGER_LOCKED__')
          .map(a => a.wager));
        for (let i = 1; i <= total; i++) if (!spent.has(i)) return i;
        return 1;
      };

      if (name === 'op_fill_blank_answers') {
        let written = 0;
        for (const p of this.table('players').filter(p => String(p.room_id) === String(room.id))) {
          const rows = this.table('answers');
          const existing = rows.find(a => String(a.room_id) === String(room.id)
            && String(a.player_id) === String(p.id) && a.question_number === qnum);
          if (existing) {
            // Only a placeholder is converted. A real answer is never
            // overwritten by a blank — the race that once destroyed answers
            // people had typed.
            if (String(existing.submitted_answer || '').trim() !== '__WAGER_LOCKED__') continue;
            const before = { ...existing };
            existing.submitted_answer = '';
            existing.wager = isFinal ? 0 : nextWager(p.id);
            existing.is_correct = false;
            existing.auto_correct = false;
            existing.score_earned = 0;
            this._broadcast('UPDATE', 'answers', { ...existing }, before);
          } else {
            const row = {
              id: newId('answers'), room_id: room.id, player_id: p.id,
              question_number: qnum, question_id: qid,
              wager: isFinal ? 0 : nextWager(p.id),
              submitted_answer: '', is_correct: false, auto_correct: false, score_earned: 0,
            };
            rows.push(row);
            this._broadcast('INSERT', 'answers', { ...row }, null);
          }
          written++;
        }
        return written;
      }

      const player = this.table('players').find(p => String(p.id) === String(args.p_player_id)
        && String(p.room_id) === String(room.id));
      if (!player) {
        return [{ is_correct: false, score_earned: 0, wager: null, question_id: null, rejected: 'not in this room' }];
      }
      if (qnum !== room.current_question) {
        return [{ is_correct: false, score_earned: 0, wager: null, question_id: null, rejected: 'not the current question' }];
      }
      // The timer, with the same generous allowance the SQL uses. Left out of
      // this fake, a scenario would pass on an answer the live server refuses —
      // which is the exact shape of every "worked in the harness" bug in
      // CLAUDE.md. The app falls back rather than losing the round, so a
      // rejection here still ends with the answer stored, as it does live.
      if (room.question_started_at) {
        const deadline = new Date(room.question_started_at).getTime()
          + ((room.question_timer ?? 30) + 3) * 1000;
        if (Date.now() > deadline) {
          return [{ is_correct: false, score_earned: 0, wager: null, question_id: null, rejected: 'time is up' }];
        }
      }

      const question = this.table('questions').find(q => String(q.id) === String(qid));
      const text = String(args.p_answer ?? '');
      const verdict = (question && text.trim())
        ? fuzzyMatch(text, question.correct_answer, question.acceptable_answers || [])
        : false;

      const rows = this.table('answers');
      const existing = rows.find(a => String(a.room_id) === String(room.id)
        && String(a.player_id) === String(player.id) && a.question_number === qnum);

      let chosen;
      if (isFinal && existing?.wager != null) chosen = existing.wager;          // locked is locked
      else if (isFinal) chosen = [0, 10, 20].includes(args.p_wager) ? args.p_wager : 0;
      else if (existing?.wager != null) chosen = existing.wager;                // spent once, only once
      else {
        chosen = args.p_wager;
        const alreadySpent = rows.some(a => String(a.room_id) === String(room.id)
          && String(a.player_id) === String(player.id) && a.question_number < total
          && a.wager === chosen && String(a.submitted_answer || '').trim() !== '__WAGER_LOCKED__');
        if (chosen == null || chosen < 1 || chosen > total || alreadySpent) chosen = nextWager(player.id);
      }

      const earned = verdict ? chosen : (isFinal ? -chosen : 0);
      // Every write here is broadcast, because an UPDATE inside a Postgres
      // function reaches Realtime exactly like one from a client — it is in the
      // WAL either way. A fake that mutated rows silently would leave every
      // other phone in the room unaware that anybody had answered.
      if (existing) {
        const before = { ...existing };
        Object.assign(existing, {
          submitted_answer: text, question_id: qid, wager: chosen,
          is_correct: verdict, auto_correct: verdict, score_earned: earned,
        });
        this._broadcast('UPDATE', 'answers', { ...existing }, before);
      } else {
        const row = {
          id: newId('answers'), room_id: room.id, player_id: player.id,
          question_number: qnum, question_id: qid, wager: chosen,
          submitted_answer: text, is_correct: verdict, auto_correct: verdict,
          score_earned: earned,
        };
        rows.push(row);
        this._broadcast('INSERT', 'answers', { ...row }, null);
      }
      return [{ is_correct: verdict, score_earned: earned, wager: chosen, question_id: qid, rejected: null }];
    }

    // Mirrors migration 032, which the probe confirms is installed. Until this
    // existed the fake store answered every unknown RPC with null-and-no-error
    // — which is what an INSTALLED function returning nothing looks like, so
    // fetchMasteryCounts never took its fallback and the mastery tree and the
    // Map were empty in every scenario. Not a bug in either; a hole in here.
    //
    // One row per (category, subcategory), no rollups: profile.js adds each
    // row to BOTH its category total and its subcategory, so a rollup row
    // would count every question twice at category level.
    if (name === 'get_mastery_counts') {
      const uid = String(args?.p_user_id ?? '');
      if (!uid) return [];
      const questions = this.table('questions');
      const counts = new Map();
      for (const h of this.table('question_history')) {
        if (String(h.user_id) !== uid || !h.last_correct) continue;
        const q = questions.find(x => String(x.id) === String(h.question_id));
        if (!q) continue;
        for (const category of (q.categories || [])) {
          const key = `${category}|${q.subcategory || ''}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      return [...counts].map(([key, mastered]) => {
        const [category, subcategory] = key.split('|');
        return { category, subcategory: subcategory || null, mastered };
      });
    }

    // Mirrors migration 025: one row per question, counting how it performed.
    // Recorded here so a scenario can assert what is NOT counted — a bot's
    // answers must never reach this table, because they come from a chosen
    // percentage rather than from anybody playing.
    if (name === 'record_question_outcome') {
      if (!args?.p_question_id) return null;
      const rows = this.table('question_stats');
      const existing = rows.find(r => String(r.question_id) === String(args.p_question_id));
      const correct = args.p_is_correct ? 1 : 0;
      const overridden = args.p_overridden ? 1 : 0;
      if (existing) {
        existing.times_asked += 1;
        existing.times_correct += correct;
        existing.times_overridden += overridden;
      } else {
        rows.push({
          question_id: args.p_question_id,
          times_asked: 1,
          times_correct: correct,
          times_overridden: overridden,
        });
      }
      return null;
    }

    // Mirrors migration 029: count what was typed, keyed on lowercased and
    // trimmed text, keeping one example of the original spelling. Blank
    // answers are ignored — somebody running out of time says nothing about
    // the question.
    if (name === 'record_answer_text') {
      const shown = String(args?.p_answer ?? '').trim().slice(0, 120);
      if (!args?.p_question_id || !shown) return null;
      const key = shown.toLowerCase();
      const rows = this.table('answer_tally');
      const existing = rows.find(r =>
        String(r.question_id) === String(args.p_question_id) && r.answer_key === key);
      if (existing) existing.times_given += 1;
      else rows.push({
        question_id: args.p_question_id, answer_key: key,
        answer_shown: shown, times_given: 1,
      });
      return null;
    }

    return null;
  }
}
