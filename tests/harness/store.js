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
// ============================================

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
