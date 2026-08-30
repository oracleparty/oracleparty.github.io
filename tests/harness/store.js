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
// title_words is bigint IDENTITY too (migration 063). Added when the table was,
// rather than after a scenario reported something impossible: an integer-PK
// table handed uuids is exactly the gap that made accepting a friend request
// silently match no row.
const INTEGER_PK = new Set(['friend_requests', 'title_words']);
let nextIntId = 1;
const newId = table => (INTEGER_PK.has(table) ? nextIntId++ : uuid());

export class FakeStore {
  constructor() {
    this.tables = new Map();       // name -> array of row objects
    this._denied = new Set();      // tables whose writes are refused, RLS-style
    this._slowReads = new Map();   // table -> extra ms, for forcing a race to lose
    this._dropEvents = new Map();  // table -> how many realtime events to swallow
    this._missing = new Set();     // tables that answer as if they do not exist
    this._hiddenFunctions = new Set();  // RPCs that answer PGRST202
    this._slowFunctions = new Map();    // RPC -> ms before it answers
    this._checks = new Map();      // table -> [{ predicate, name }], simulating CHECK constraints
    // Doors the LIVE database has shut, so the fake refuses what it refuses.
    // See _shutDoor below — this is not a scenario knob, it is the schema.
    // UNIQUE indexes the live database actually has. Measured, not invented:
    // CLAUDE.md #2 records that answers, question_feedback and game_plays each
    // carry the index their onConflict needs (checked because a missing one
    // raises 42P10 and kills every write through that path), and rooms.code is
    // unique because the app has a 23505 retry loop built around it.
    //
    // DELIBERATELY ABSENT: friend_requests(sender_id, receiver_id) and any pair
    // key on friendships. Migration 003 declares them and the live tables do
    // NOT have them — three rows for one pair were found on the owner's own
    // account. Adding them here would make the harness stricter than production
    // and hide exactly the duplicate-row bugs that shipped (CLAUDE.md #10).
    this._uniqueIndexes = new Map([
      ['rooms',             [['code']]],
      ['answers',           [['room_id', 'player_id', 'question_number']]],
      ['question_feedback', [['question_id', 'voter_id']]],
      ['game_plays',        [['room_id', 'player_id']]],
    ]);
    // COLUMN GRANTS, the other half of the lockdown and the half this store
    // could not see. Migrations 058 and 061 revoked UPDATE on `players` and
    // `rooms` and re-granted a named list of columns, so an update touching
    // anything else is refused OUTRIGHT with 42501 — not filtered, not silent.
    //
    // Until this existed the harness allowed every one of those writes, which
    // is CLAUDE.md #10 in its usual direction: the fake database permitting
    // what the real one had just forbidden. Twelve scenarios passed while the
    // live game could not advance.
    //
    // A column NOT in the list here is one only a SECURITY DEFINER function may
    // write, and those mutate the table array directly rather than going
    // through _execute — the same way definer rights are modelled everywhere
    // else in this file, structurally rather than by a flag.
    this._columnGrants = new Map([
      ['players', new Set(['last_seen_at', 'disconnected_at', 'is_ready'])],
      ['rooms', new Set([
        'question_ids', 'used_question_ids',
        'question_started_at', 'countdown_started_at',
        'room_scores', 'host_name', 'status',
        'category', 'subcategory', 'who_can_join',
        'questions_per_game', 'question_timer', 'auto_proceed',
      ])],
    ]);
    this._shutDoors = new Map([
      ['answers',      new Set(['update', 'delete'])],   // migrations 049 + 050
      ['rooms',        new Set(['delete'])],             // migration 048
      // Migration 036. Chat is inserted, read and hearted, and never deleted by
      // anything — checked against js/db/chat.js rather than assumed. Before it,
      // any visitor could have wiped every message and every archive.
      //
      // Messages still disappear when their room does: a cascade runs as the
      // table owner and is unaffected by policies, which is why
      // _deleteRoomCascade splices them directly rather than going through here.
      ['chat_messages', new Set(['delete'])],
      ['chat_archive',  new Set(['update', 'delete'])],
      // Migration 055. Every number the app shows about a player derives from
      // this table, and migration 011 let a signed-in client write their own
      // rows directly — so a leaderboard position, a tier and every title could
      // be set to anything in one request, without playing.
      //
      // The three SECURITY DEFINER writers (record_round_history,
      // amend_question_history, revoke_question_history) are unaffected, and in
      // this store that is modelled structurally rather than by a flag: they
      // mutate the table array directly instead of going through _execute, the
      // way a definer-rights function runs with the owner's rights rather than
      // the caller's.
      ['question_history', new Set(['insert', 'update', 'delete'])],
      // Migration 057. Anyone could remove any player from any live game,
      // mid-round, with their score, in one request. INSERT and UPDATE stay
      // open: joining, the ready flag, the heartbeat and host promotion are all
      // still browser writes, and revoking UPDATE here would stop every
      // heartbeat — far worse than the hole it would close.
      ['players', new Set(['delete'])],
    ]);
    // Migration 058: columns a client may NOT write. The role is what a host
    // overrides verdicts with, and 041 makes an override amend the permanent
    // question_history of every player it touches.
    this._lockedColumns = new Map([
      ['players', new Set(['is_host', 'is_cohost'])],
      // Migration 061: the two most damaging columns in the database. Anyone
      // could shove a live game to results, back to lobby, or on to a question
      // nobody had been asked.
      ['rooms', new Set(['game_phase', 'current_question'])],
    ]);
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
  /**
   * Everything an account leaves behind, in ONE place.
   *
   * delete_my_account and admin_delete_account share this list deliberately,
   * exactly as migrations 035 and 037 do: if one grows a table the other does
   * not, "I deleted my account" and "an admin deleted my account" stop meaning
   * the same thing, and nothing would say so.
   */
  _purgeAccount(uid) {
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
  }

  /**
   * Everything that dies with a room, because the live database says so.
   *
   * MEASURED, not assumed. Migration 052's output on the live project reported
   * `answers.room_id -> rooms ON DELETE CASCADE`, and CLAUDE.md records that
   * chat disappears with its room the same way. Players plainly do too — a
   * deleted room leaves nobody behind in it.
   *
   * `game_plays` deliberately does NOT: migration 033 dropped its keys to both
   * rooms and players precisely so a play record would stop being destroyed
   * seconds after it was written.
   *
   * And `answers.player_id` no longer cascades at all as of 052, which is what
   * lets a rejoining player recover their score. So a PLAYER deletion takes
   * nothing with it, and only the room does.
   *
   * The fake store had none of this and simply left the rows behind. That is
   * the CLAUDE.md #10 gap in its usual direction: the harness allowing what the
   * real database would already have swept away.
   */
  _deleteRoomCascade(roomId) {
    const rooms = this.table('rooms');
    const idx = rooms.findIndex(r => String(r.id) === String(roomId));
    if (idx === -1) return false;

    for (const child of ['answers', 'players', 'chat_messages']) {
      const rows = this.table(child);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i].room_id) !== String(roomId)) continue;
        const [gone] = rows.splice(i, 1);
        this._broadcast('DELETE', child, null, gone);
      }
    }

    const [goneRoom] = rooms.splice(idx, 1);
    this._broadcast('DELETE', 'rooms', null, goneRoom);
    return true;
  }

  /**
   * Return only the columns the caller asked for, as PostgREST does.
   *
   * The shim used to throw the column list away and the store handed back whole
   * rows, so a query that FORGOT a column behaved exactly like one that did
   * not. That is not a small difference: rowProficiency and
   * bucketQuestionsByHistory both fall back to older columns when the newer
   * ones are absent, and "absent" is precisely what a short select produces
   * live. The category leaderboard shipped ranking by the lifetime hit rate for
   * that reason, and no scenario could see it.
   *
   * Only a plain comma-separated list is honoured. `*`, embedded resources
   * (`players(id)`), aliases and anything else is returned whole rather than
   * guessed at — a projection that is wrong in the other direction would hide
   * bugs just as effectively.
   */
  _project(row, columns) {
    if (!columns || typeof columns !== 'string') return { ...row };
    const spec = columns.trim();
    if (!spec || spec === '*' || /[(:*]/.test(spec)) return { ...row };
    const wanted = spec.split(',').map(c => c.trim()).filter(Boolean);
    if (!wanted.length || wanted.some(c => !/^[A-Za-z_][\w]*$/.test(c))) return { ...row };
    const out = {};
    for (const c of wanted) out[c] = row[c];
    return out;
  }

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

  /**
   * Make an RPC answer PGRST202 — "could not find the function" — the way
   * PostgREST does for one a migration has not been run.
   *
   * The same gap denyReads exists for, one layer along. An RPC this store does
   * not implement returns NULL WITH NO ERROR, which is indistinguishable from
   * an installed function that found nothing, so every `functionMissing`
   * fallback in js/db/ was unreachable from a scenario and shipped untested.
   * Migrations here are pasted by hand (CLAUDE.md #7), so the window where the
   * JavaScript is deployed and the SQL is not is a real state the app runs in —
   * and it is the state the fallbacks exist for.
   *
   * PGRST202 also covers a function that EXISTS under different argument names,
   * which is just as dead to the app as one that was never created (#6).
   */
  hideFunction(name) { this._hiddenFunctions.add(name); }
  /** Undo hideFunction. */
  showFunction(name) { this._hiddenFunctions.delete(name); }
  /**
   * Make one RPC take a long time WITHOUT failing — the shape a phone on a bad
   * connection actually produces. hideFunction models "not installed", which
   * returns instantly and takes the fallback; this models a request that has
   * not come back yet, which is what freezes a screen. A promise that never
   * settles cannot be caught by try/catch, so only a bounded wait survives it.
   */
  slowFunction(name, ms) { this._slowFunctions.set(name, ms); }
  /** Undo slowFunction. */
  normalFunction(name) { this._slowFunctions.delete(name); }

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

    // COUNTING QUERIES ARE COUNTED. A screen that re-measures the whole
    // question bank on every interaction works perfectly and is unusable, and
    // that is invisible from the outside — the admin's Title Words panel
    // shipped exactly that way, ~60 counts per saved word against ~86 words to
    // write. Nothing but a tally can see it.
    if (action === 'select' && modifiers?.count) {
      this.countsTaken = (this.countsTaken || 0) + 1;
    }

    // Simulate an RLS refusal, which is the single most misleading thing this
    // database does: a policy that denies a write does NOT return an error. The
    // statement succeeds and affects zero rows, so `if (error)` is false and the
    // caller reports success while nothing was saved. That is how the admin page
    // said "Saved!" for months without saving anything.
    //
    // denyWrites('questions') makes this store behave the same way, so the code
    // paths that are supposed to notice can actually be tested.
    // An UPDATE naming a column the client was never granted is refused whole,
    // before any row is touched. Postgres checks column privileges independently
    // of RLS, which is why 058 and 061 could lock the host flag and the game
    // phase without a function per write.
    if (action === 'update' && this._columnGrants.has(table)) {
      const granted = this._columnGrants.get(table);
      const ungranted = Object.keys(payload || {}).filter(c => !granted.has(c));
      if (ungranted.length) {
        return {
          data: null, error: {
            code: '42501',
            message: `permission denied for column ${ungranted[0]} of relation ${table}`,
            details: `client may not write: ${ungranted.join(', ')}`,
          },
        };
      }
    }

    if (this._denied.has(table) && action !== 'select') {
      return modifiers.single
        ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
        : { data: [], error: null, count: 0 };
    }

    // ---- doors the live database has shut ----------------------------------
    //
    // Migrations 048–050 revoked UPDATE and DELETE on `answers` and DELETE on
    // `rooms`, so nobody with the publishable key can edit a live game's scores
    // or delete a room out from under it. The fake store had none of that, and
    // the gap hid a REAL regression: Play Again's answer-clearing, a rejoining
    // player's answers and a bot's final answer all went through those doors,
    // all three stopped working live, and every scenario went on passing.
    //
    // The three behaviours below are MEASURED against a real Postgres with the
    // policies removed, not assumed, because they are not the same:
    //
    //   UPDATE / DELETE              -> 0 rows, NO ERROR. Silent.
    //   INSERT .. ON CONFLICT DO UPDATE -> hard error 42501. Loud.
    //   INSERT .. ON CONFLICT DO NOTHING -> fine, 0 rows inserted.
    //   plain INSERT refused by WITH CHECK -> hard error 42501. Loud.
    //
    // The middle one matters most: an upsert that lands on an existing row does
    // not fail quietly, it throws, so code relying on it breaks visibly rather
    // than drifting.
    //
    // The last is different from the first two in the way that matters here: an
    // INSERT is refused by WITH CHECK, which raises, while UPDATE and DELETE are
    // filtered by USING, which matches nothing and reports success. Same
    // permission, two completely different things to code against — which is
    // why they are modelled separately rather than as one "refused".
    // COLUMN-LEVEL REFUSAL (migration 058). Postgres enforces column privileges
    // independently of RLS: with no table-wide UPDATE grant and only three
    // columns granted, `UPDATE players SET is_host = true` is refused outright
    // rather than matching zero rows. Modelled here so a scenario cannot pass on
    // a write the live database rejects — the faithfulness gap CLAUDE.md #10 is
    // about, in the direction that hides bugs.
    const locked = this._lockedColumns.get(table);
    if (locked && action === 'update') {
      const payload0 = Array.isArray(payload) ? (payload[0] || {}) : (payload || {});
      const bad = Object.keys(payload0).filter(k => locked.has(k));
      if (bad.length) {
        return {
          data: null,
          error: {
            message: `permission denied for column ${bad[0]} of relation "${table}"`,
            code: '42501',
          },
        };
      }
    }

    const shut = this._shutDoors.get(table);
    if (shut && action === 'insert' && shut.has('insert')) {
      return {
        data: null,
        error: {
          message: `new row violates row-level security policy for table "${table}"`,
          code: '42501',
        },
      };
    }
    if (shut && (action === 'update' || action === 'delete') && shut.has(action)) {
      return modifiers.single
        ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
        : { data: [], error: null, count: 0 };
    }
    if (shut && shut.has('update') && action === 'upsert' && !modifiers.ignoreDuplicates) {
      const incoming = Array.isArray(payload) ? payload : [payload];
      const keys = (modifiers.onConflict || 'id').split(',').map(s => s.trim());
      const hitsExisting = incoming.some(item =>
        rows.some(r => keys.every(k => String(r[k]) === String(item[k]))));
      if (hitsExisting) {
        return {
          data: null,
          error: {
            message: `new row violates row-level security policy (USING expression) for table "${table}"`,
            code: '42501',
          },
        };
      }
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
        let result = this._applyFilters(rows, filters).map(r => this._project(r, modifiers.columns));
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
          // UNIQUE indexes. A plain INSERT that collides raises 23505 and the
          // whole statement writes nothing — which is how the app's room-code
          // retry loop is reachable, and how a second rating on one question by
          // one person is refused. The store used to enforce only rooms.code,
          // so every other collision silently succeeded here and failed live.
          const dup = (this._uniqueIndexes.get(table) || []).find(cols =>
            cols.every(c => item[c] != null)
            && rows.some(r => cols.every(c => String(r[c]) === String(item[c]))));
          if (dup) {
            return { data: null, error: {
              code: '23505',
              message: `duplicate key value violates unique constraint on ${table} (${dup.join(', ')})`,
            } };
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
        if (this._hiddenFunctions.has(table)) {
          return {
            data: null,
            error: {
              message: `Could not find the function public.${table} in the schema cache`,
              code: 'PGRST202',
            },
          };
        }
        // A request that has not come back YET, which is not the same as one
        // that failed. Only a bounded wait on the caller's side survives it.
        const rpcDelay = this._slowFunctions.get(table);
        if (rpcDelay) await new Promise(r => setTimeout(r, rpcDelay));
        return { data: this._rpc(table, payload), error: null };
      }

      return { data: null, error: { message: `unsupported action ${action}` } };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  /**
   * Rebuild host_reputation from host_ratings.
   *
   * A VIEW on the live database, so it can never be stale there. The store has
   * no views, and seeding the derived table directly would let a scenario
   * assert a percentage the ratings do not support — which is the harness
   * telling itself a story rather than testing the app.
   */
  _recomputeHostReputation() {
    const byHost = new Map();
    for (const r of this.table('host_ratings')) {
      const acc = byHost.get(String(r.host_user_id))
        || { host_user_id: r.host_user_id, ratings: 0, thumbs_up: 0, thumbs_down: 0, flags: 0 };
      if (r.rating === 1) { acc.ratings++; acc.thumbs_up++; }
      else if (r.rating === -1) { acc.ratings++; acc.thumbs_down++; }
      if (r.flag_reason) acc.flags++;
      byHost.set(String(r.host_user_id), acc);
    }
    const out = this.table('host_reputation');
    out.length = 0;
    for (const acc of byHost.values()) {
      out.push({
        ...acc,
        pct_positive: acc.ratings === 0 ? null : Math.round(100 * acc.thumbs_up / acc.ratings),
      });
    }
  }

  /**
   * Has this room's host been heard from within `ms`? The stand-in for
   * op_room_host_seen_within (migration 062).
   *
   * ONE IMPLEMENTATION, TWO CALLERS, EACH NAMING ITS OWN WINDOW — which is the
   * whole point of the migration. Advancing the game uses the deputy's window
   * and taking the crown uses the stale-seat one, and this file previously had
   * the longer number copied into both, so the harness agreed with the bug.
   *
   * CANNOT TELL MEANS HERE: a host row with no timestamps at all counts as
   * present, so a room is not declared leaderless just because nobody has
   * heartbeated yet. Same rule as everywhere else in this project.
   */
  _hostSeenWithin(roomId, ms) {
    return this.table('players').some(p =>
      String(p.room_id) === String(roomId)
      && p.is_host && !p.is_bot
      && (!(p.last_seen_at || p.joined_at)
          || Date.now() - new Date(p.last_seen_at || p.joined_at).getTime() < ms));
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
      this._purgeAccount(uid);
      return null;
    }

    // Migration 037. Deliberately shares delete_my_account's purge list: if one
    // grows a table the other does not, "I deleted my account" and "an admin
    // deleted my account" stop meaning the same thing.
    //
    // Its three guards RAISE rather than return, so they arrive at the client
    // as an error — which is the difference between "nothing happened" and
    // "the page told you why". The fake has to raise too, or a scenario would
    // pass on a refusal the live function turns into a visible failure.
    if (name === 'admin_delete_account') {
      const caller = args?.__callerUserId ?? null;
      const target = args?.p_user_id ?? null;
      const isAdmin = id => this.table('profiles')
        .some(p => String(p.user_id) === String(id) && p.is_admin);
      if (!caller) throw new Error('admin_delete_account: not signed in');
      if (!isAdmin(caller)) throw new Error('admin_delete_account: not an admin');
      if (!target) throw new Error('admin_delete_account: no account given');
      if (String(target) === String(caller)) {
        throw new Error('admin_delete_account: use Delete Account on your own profile');
      }
      if (isAdmin(target)) {
        throw new Error('admin_delete_account: remove their admin rights first');
      }
      this._purgeAccount(target);
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

    // ---- migration 051: the three writes slice 6 took away ------------------
    //
    // 049/050 shut UPDATE and DELETE on `answers`, which silently killed three
    // legitimate writes. These are their replacements, and each is implemented
    // here with its REFUSAL as well as its success — a fake that only does the
    // happy path would let a scenario pass on a write the live server rejects,
    // which is the shape of every "worked in the harness" bug in CLAUDE.md.
    if (name === 'op_reset_answers') {
      const players = this.table('players');
      const caller = players.find(p => String(p.id) === String(args?.p_caller_id)
        && String(p.room_id) === String(args?.p_room_id));
      if (!caller || !(caller.is_host || caller.is_cohost)) return -1;
      const answers = this.table('answers');
      const doomed = answers.filter(a => String(a.room_id) === String(args.p_room_id));
      for (const a of doomed) {
        const i = answers.indexOf(a);
        if (i >= 0) answers.splice(i, 1);
        this._broadcast('DELETE', 'answers', null, { ...a });
      }
      return doomed.length;
    }

    if (name === 'op_reassign_answers') {
      const { p_room_id: roomId, p_old_player_id: oldId, p_new_player_id: newId } = args || {};
      if (!oldId || !newId || String(oldId) === String(newId)) return 0;
      const players = this.table('players');
      // The old seat still exists — this is not a rejoin, it is a theft.
      if (players.some(p => String(p.id) === String(oldId))) return -1;
      if (!players.some(p => String(p.id) === String(newId)
        && String(p.room_id) === String(roomId))) return -1;

      const answers = this.table('answers');
      const mine = answers.filter(a => String(a.room_id) === String(roomId)
        && String(a.player_id) === String(newId));
      const taken = new Set(mine.map(a => a.question_number));
      let moved = 0;
      for (const a of [...answers]) {
        if (String(a.room_id) !== String(roomId)) continue;
        if (String(a.player_id) !== String(oldId)) continue;
        // The row they wrote as themselves is newer and wins; moving the stale
        // one onto it would collide on (room, player, question).
        if (taken.has(a.question_number)) {
          const i = answers.indexOf(a);
          if (i >= 0) answers.splice(i, 1);
          this._broadcast('DELETE', 'answers', null, { ...a });
          continue;
        }
        const before = { ...a };
        a.player_id = newId;
        this._broadcast('UPDATE', 'answers', { ...a }, before);
        moved++;
      }
      return moved;
    }

    if (name === 'op_bot_answer') {
      const players = this.table('players');
      const target = players.find(p => String(p.id) === String(args?.p_player_id)
        && String(p.room_id) === String(args?.p_room_id));
      // The guard is is_bot, not "the caller is the host": nothing a PERSON
      // plays can be written through here at all.
      if (!target || !target.is_bot) return false;
      const room = this.table('rooms').find(r => String(r.id) === String(args.p_room_id));
      if (!room) return false;

      const ids = room.question_ids || [];
      const total = Math.max(1, (ids.length ? ids.length - 1 : room.questions_per_game) || 10);
      const isFinal = args.p_question_number >= total;
      const wager = args.p_wager || 0;
      const points = args.p_is_correct ? wager : (isFinal ? -wager : 0);

      const answers = this.table('answers');
      const existing = answers.find(a => String(a.room_id) === String(args.p_room_id)
        && String(a.player_id) === String(args.p_player_id)
        && a.question_number === args.p_question_number);

      if (existing) {
        const held = String(existing.submitted_answer || '').trim();
        // Never overwrite an answer the bot already gave for real.
        if (held !== '' && held !== '__WAGER_LOCKED__') return true;
        const before = { ...existing };
        existing.submitted_answer = args.p_answer || '';
        existing.question_id = args.p_question_id;
        existing.is_correct = !!args.p_is_correct;
        existing.auto_correct = !!args.p_is_correct;
        existing.score_earned = points;
        this._broadcast('UPDATE', 'answers', { ...existing }, before);
        return true;
      }

      const row = {
        id: newId('answers'),
        room_id: args.p_room_id,
        player_id: args.p_player_id,
        question_number: args.p_question_number,
        question_id: args.p_question_id,
        wager,
        submitted_answer: args.p_answer || '',
        is_correct: !!args.p_is_correct,
        auto_correct: !!args.p_is_correct,
        score_earned: points,
        history_recorded: false,
        created_at: new Date().toISOString(),
      };
      answers.push(row);
      this._broadcast('INSERT', 'answers', { ...row }, null);
      return true;
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

      this._deleteRoomCascade(args.p_room_id);
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
          this._deleteRoomCascade(r.id);
          gone++;
        }
      }
      return gone;
    }

    // ---- migration 051: an admin ends a stuck room -------------------------
    //
    // Unlike op_sweep_rooms this deletes a room that still has people in it,
    // so it is the one function in the rebuild that checks WHO is calling —
    // an admin is signed in by definition, where a host very often is not.
    // The refusal is modelled too: "you are not an admin" must never reach the
    // screen looking like "the room was already gone".
    if (name === 'op_admin_end_room') {
      // __callerUserId is what client-shim.js puts on every RPC payload — the
      // harness's stand-in for auth.uid(). A guest has none, and gets nowhere.
      const me = args?.__callerUserId || null;
      const admin = me && this.table('profiles').some(p =>
        String(p.user_id) === String(me) && p.is_admin);
      if (!admin) return false;
      return this._deleteRoomCascade(args?.p_room_id);
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

    // ---- migration 060: the server moves the game on ----------------------
    //
    // The phase is the most damaging column on `rooms`: with UPDATE open,
    // anyone could shove a live game to `results`, back to `lobby`, or on to a
    // question nobody has been asked. Mirrored here so the scenarios take the
    // path the app now takes, and written to REFUSE for the same reasons —
    // a fake that always advanced would let a scenario pass on a move the live
    // server rejects.
    if (name === 'op_set_phase') {
      const PHASES = ['lobby', 'countdown', 'question', 'reveal', 'answer_reveal',
                      'scores_reveal', 'final_wager', 'final_question', 'results'];
      // NULL MEANS "CLEAR THE PHASE", which migration 061 taught the real
      // function to express and this stand-in used to reject as 'not a phase'.
      // The lobby's pre-start reset is the one caller that sends it, and a room
      // sitting on 'lobby' instead of null behaves differently — syncToCurrentState
      // returns early on a falsy phase — so the harness was quietly running a
      // different game from the live site at exactly that moment.
      if (args?.p_to_phase != null && !PHASES.includes(args.p_to_phase)) return 'not a phase';
      const room = this.table('rooms').find(r => String(r.id) === String(args?.p_room_id));
      if (!room) return 'already moved';
      const caller = this.table('players').find(p =>
        String(p.id) === String(args?.p_caller_id) && String(p.room_id) === String(room.id));
      if (!caller || caller.is_bot) return 'not allowed';

      // ADVANCING USES THE DEPUTY'S WINDOW, NOT THE CROWN'S (migration 062).
      // These are two different questions with two different answers, and this
      // file had the 120-second one copied into both — the same conflation the
      // migration fixes server-side.
      if (!(caller.is_host || caller.is_cohost
            || !this._hostSeenWithin(room.id, 25000))) return 'not allowed';

      // COMPARE-AND-SET: a stale click cannot rewind a game, and two phones
      // pressing at once move it exactly one step.
      const expected = args?.p_expected_phase ?? null;
      if (expected !== null && (room.game_phase ?? null) !== expected) return 'already moved';

      const before = { ...room };
      room.game_phase = args.p_to_phase;
      if (args.p_question !== null && args.p_question !== undefined) {
        room.current_question = args.p_question;
      }
      // AND TELL EVERYBODY — an UPDATE inside a Postgres function reaches
      // Realtime like any other. A fake that mutated silently leaves every
      // other phone waiting forever, which is what made scenario-nasty report
      // "the room is stuck" when the clock stamp first moved server-side.
      this._broadcast('UPDATE', 'rooms', { ...room }, before);
      return 'ok';
    }

    // ---- migration 058: only the rules make you host ----------------------
    //
    // `players` no longer grants a client UPDATE on is_host / is_cohost, so a
    // direct write is refused OUTRIGHT rather than matching zero rows. A host
    // overrides the machine's verdict on any answer, and 041 makes that amend
    // the permanent question_history of everyone it touches — so one request
    // took over a game and let the taker rewrite other people's records.
    if (name === 'op_set_host_role') {
      if (!['host', 'cohost'].includes(args?.p_role)) return 'not a role';
      const rows = this.table('players');
      const inRoom = id => rows.find(p => String(p.id) === String(id)
        && String(p.room_id) === String(args?.p_room_id));
      const target = inRoom(args?.p_target_id);
      const caller = inRoom(args?.p_caller_id);
      if (!target || !caller) return 'not in this room';
      // A bot is never host or co-host: a room whose host is a bot is a room
      // nobody can start, advance or judge.
      if (args.p_value && target.is_bot) return 'not allowed';

      // THE CROWN KEEPS THE FULL TWO MINUTES. Taking the role is hard to undo —
      // a host who glanced at a notification must not come back to find they no
      // longer run their game — where advancing is not, which is why 062 gives
      // the two different windows.
      const callerIsHost = !!caller.is_host;
      if (!(callerIsHost || !this._hostSeenWithin(args.p_room_id, 120000))) return 'not allowed';

      const touch = (row, patch) => {
        const before = { ...row };
        Object.assign(row, patch);
        this._broadcast('UPDATE', 'players', { ...row }, before);
      };

      if (args.p_role === 'cohost') {
        touch(target, { is_cohost: !!args.p_value });
        return 'ok';
      }
      if (args.p_value) {
        // CLEAR THE ROOM FIRST, THEN SET. The other order leaves two hosts,
        // which is the photographed "two abandoned copies both flagged HOST".
        for (const p of rows) {
          if (String(p.room_id) === String(args.p_room_id) && p.is_host) touch(p, { is_host: false });
        }
        touch(target, { is_host: true });
      } else {
        touch(target, { is_host: false });
      }
      return 'ok';
    }

    // ---- migration 057: only the rules remove a player --------------------
    //
    // `players` had FOR DELETE USING (true), so anyone reaching the site could
    // remove any player from any live game in one request. Mirrored here so the
    // scenarios take the path the app now takes, and written to REFUSE for the
    // same reasons the real one does — a fake that always removed would let a
    // scenario pass on a delete the live server rejects.
    if (name === 'op_remove_player') {
      const rows = this.table('players');
      const target = rows.find(p => String(p.id) === String(args?.p_target_id)
        && String(p.room_id) === String(args?.p_room_id));
      if (!target) return 'already gone';
      const caller = rows.find(p => String(p.id) === String(args?.p_caller_id)
        && String(p.room_id) === String(args?.p_room_id));

      const isHost = !!(caller && caller.is_host);
      const seenAt = new Date(target.last_seen_at || target.joined_at || 0).getTime();
      const hasStamp = !!(target.last_seen_at || target.joined_at);
      const silence = Date.now() - seenAt;
      const threshold = target.disconnected_at ? 45000 : 120000;

      let allowed = false;
      if (String(args.p_caller_id) === String(args.p_target_id)) {
        allowed = true;                                   // leaving
      } else if (target.is_bot && isHost) {
        allowed = true;                                   // the host's bot
      } else if (caller?.user_id && target.user_id
                 && String(caller.user_id) === String(target.user_id)) {
        allowed = true;                                   // a duplicate of your own seat
      } else if (caller) {
        // The stale sweep. A BOT IS NEVER SWEPT — it sends no heartbeat, so by
        // the timestamp rule it is stale from the moment it is added, and
        // anybody in the room could delete the host's bot mid-game.
        // CANNOT TELL MEANS HERE: a row with no timestamp at all is protected.
        allowed = !target.is_bot && hasStamp && silence >= threshold;
      }
      if (!allowed) return 'not allowed';

      const at = rows.findIndex(p => String(p.id) === String(target.id));
      if (at === -1) return 'already gone';
      const [gone] = rows.splice(at, 1);
      this._broadcast('DELETE', 'players', gone, null);
      return 'removed';
    }

    // ---- migration 056: the game advances without the host -----------------
    //
    // A mirror of op_advance_phase. Only the TIME-BASED transitions live here,
    // which is the same boundary the SQL draws: a clock decided them, so any
    // phone may report it. The host pressing "Reveal Results" is a person
    // deciding, and stays where it is.
    //
    // Written to REFUSE for the same reasons the real one does, not just to
    // succeed — a fake that always advances would let a scenario pass on a
    // round the live server would have left alone, which is the shape of every
    // "worked in the harness" bug in CLAUDE.md.
    if (name === 'op_advance_phase') {
      const room = this.table('rooms').find(r => String(r.id) === String(args?.p_room_id));
      if (!room) return 'no such room';
      const inRoom = this.table('players').some(p =>
        String(p.room_id) === String(room.id) && String(p.id) === String(args?.p_caller_id));
      if (!inRoom) return 'not in this room';

      const moveTo = (phase, extra = {}) => {
        const before = { ...room };
        room.game_phase = phase;
        Object.assign(room, extra);
        // AND TELL EVERYBODY — an UPDATE inside a Postgres function reaches
        // Realtime like any other. A fake that mutated the row silently leaves
        // every other phone waiting forever, which is what made scenario-nasty
        // report "the room is stuck" when the clock stamp moved server-side.
        this._broadcast('UPDATE', 'rooms', { ...room }, before);
      };

      if (room.game_phase === 'countdown') {
        if (!room.countdown_started_at) return 'not due';
        if (Date.now() - new Date(room.countdown_started_at).getTime() < 10000) return 'not due';
        moveTo('question', { current_question: 0, question_started_at: new Date().toISOString() });
        return 'countdown -> question';
      }

      // A question announced but never stamped. Two separate writes from the
      // host's phone; die in between and no phone's timer EVER starts, so the
      // room hangs on a live question forever. The repair is to start the
      // clock, never to end the round — ending it takes a question away from
      // people who never saw the timer move.
      if ((room.game_phase === 'question' || room.game_phase === 'final_question')
          && !room.question_started_at) {
        moveTo(room.game_phase, { question_started_at: new Date().toISOString() });
        return 'clock started';
      }

      if (room.game_phase === 'question' || room.game_phase === 'final_question') {
        const deadline = new Date(room.question_started_at).getTime()
          + ((room.question_timer ?? 30) * 1000) + 8000;
        if (Date.now() < deadline) return 'not due';
        // Close everybody out BEFORE the phase moves, exactly as the SQL does —
        // otherwise a client reaches the reveal and renders "No answer" for
        // people whose rows have not been written, and the reveal is where a
        // blank stops meaning "still typing".
        this._rpc('op_fill_blank_answers', {
          p_room_id: room.id, p_question_number: room.current_question,
        });
        moveTo('reveal');
        return 'question -> reveal';
      }

      return 'nothing to do';
    }

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
            // KEEP THE WAGER THAT IS ALREADY THERE. Migration 050 writes
            // `wager = COALESCE(answers.wager, EXCLUDED.wager)` precisely so a
            // locked final wager survives the fill — zeroing it is the "I bet
            // 20 and it wagered 0" bug that migration exists to fix. What a
            // blank COSTS is expressed in score_earned, not by rewriting what
            // the player chose. This fake was zeroing it, which made the
            // harness harsher than the live database: less dangerous than the
            // other direction, and still wrong.
            if (existing.wager == null) existing.wager = isFinal ? 0 : nextWager(p.id);
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
    // Mirrors migration 053. The leaderboard reads nothing else, so without it
    // here every scenario would exercise the FALLBACK rather than the path the
    // app actually takes live — which is precisely how a new feature ships
    // unplayed (CLAUDE.md, on op_submit_answer).
    //
    // COUNT(DISTINCT question_id), not a sum of times_seen, and the same
    // COALESCE(last_correct, times_correct > 0) fallback the SQL has: a fake
    // that counted attempts would make a board look right here and wrong live.
    if (name === 'get_leaderboard') {
      const ids = new Set((args?.p_user_ids || []).map(String));
      if (ids.size === 0) return [];
      const cat = args?.p_category ?? null;
      const sub = args?.p_subcategory ?? null;
      const since = args?.p_since ? new Date(args.p_since).getTime() : null;
      const questions = this.table('questions');
      const byUser = new Map();
      for (const h of this.table('question_history')) {
        if (!ids.has(String(h.user_id))) continue;
        if (since != null && new Date(h.last_seen_at || 0).getTime() < since) continue;
        const q = questions.find(x => String(x.id) === String(h.question_id));
        if (!q) continue;
        if (cat && !(q.categories || []).includes(cat)) continue;
        // LIKE 'key%' — subcategories nest (human -> human-countries).
        if (sub && !String(q.subcategory || '').startsWith(sub)) continue;
        const acc = byUser.get(String(h.user_id))
          || { user_id: h.user_id, met: new Set(), mastered: new Set() };
        acc.met.add(String(h.question_id));
        const knows = h.last_correct == null ? (h.times_correct > 0) : !!h.last_correct;
        if (knows) acc.mastered.add(String(h.question_id));
        byUser.set(String(h.user_id), acc);
      }
      return [...byUser.values()].map(a => ({
        user_id: a.user_id,
        questions_met: a.met.size,
        questions_mastered: a.mastered.size,
      }));
    }

    // Mirrors migration 054. The guard is the point of the function: a rating
    // anybody could write from outside the room is worth nothing, so a fake
    // that accepted everything would prove the opposite of what it tests.
    if (name === 'op_rate_host') {
      let rating = args?.p_rating ?? null;   // let: 059 may drop it while keeping a flag
      const flagReason = args?.p_flag_reason ?? null;
      if (rating == null && flagReason == null) return 'nothing to record';
      if (rating != null && rating !== 1 && rating !== -1) return 'not a rating';

      const players = this.table('players');
      const voter = players.find(p => String(p.room_id) === String(args.p_room_id)
        && String(p.id) === String(args.p_player_id));
      if (!voter) return 'not in this room';

      const host = players.find(p => String(p.room_id) === String(args.p_room_id)
        && p.is_host && p.user_id);
      if (!host) return 'host has no account';
      if (String(voter.user_id || '') === String(host.user_id)) return 'cannot rate yourself';

      // Must have actually PLAYED, not merely occupied a seat — otherwise a
      // drive-by could join a stranger's room and bury them on arrival. Checked
      // after the self-rating guard for the same reason the SQL does it in that
      // order: a refusal should name the reason the player can act on.
      const played = this.table('answers').some(a =>
        String(a.room_id) === String(args.p_room_id)
        && String(a.player_id) === String(args.p_player_id));
      if (!played) return 'you have not played a round yet';

      // THE THUMBS NEED THE WHOLE GAME; THE FLAG NEVER DOES (migration 059).
      //
      // Measured the same way the server does it: every round ends with the
      // blank fill writing a row for EVERY player in the room, so a seated
      // player accumulates one per round whether they answered or not. Somebody
      // who joined late never has the earlier ones. Being AWAY costs nothing —
      // the seat is what matters — which is exactly the line the owner drew.
      if (rating != null) {
        const room = this.table('rooms').find(r => String(r.id) === String(args.p_room_id));
        const ids = room?.question_ids || [];
        // op_room_total_questions is GREATEST(1, length - 1), so even a
        // one-question room reports two rounds. Reading it as one is how the
        // SQL rules were mis-seeded on the first attempt.
        const finalRound = Math.max(1, (ids.length ? ids.length - 1 : (room?.questions_per_game ?? 10)));
        const present = new Set(this.table('answers')
          .filter(a => String(a.room_id) === String(args.p_room_id)
            && String(a.player_id) === String(args.p_player_id)
            && a.question_number >= 0 && a.question_number <= finalRound)
          .map(a => a.question_number));
        const wholeGame = (room?.current_question ?? -1) >= finalRound
          && present.size >= finalRound + 1;
        if (!wholeGame) {
          // A flag riding along with a refused rating must still land, or the
          // one thing a leaver CAN do is lost to the rule that stops the other.
          if (flagReason == null) return 'you did not play the whole game';
          rating = null;
        }
      }

      const rows = this.table('host_ratings');
      const existing = rows.find(r => String(r.host_user_id) === String(host.user_id)
        && String(r.room_id) === String(args.p_room_id)
        && String(r.voter_id) === String(args.p_voter_id));
      if (existing) {
        // COALESCE, exactly as the SQL does: a later thumbs-up must not
        // withdraw a flag. Changing your mind about a rating is ordinary;
        // retracting a report of misconduct is not something a tap should do.
        if (rating != null) existing.rating = rating;
        if (flagReason != null) existing.flag_reason = flagReason;
        if (args?.p_flag_note != null) existing.flag_note = args.p_flag_note;
      } else {
        rows.push({
          id: newId('host_ratings'), host_user_id: host.user_id,
          room_id: args.p_room_id, voter_id: args.p_voter_id,
          voter_name: voter.display_name, rating, flag_reason: flagReason,
          flag_note: args?.p_flag_note ?? null,
          created_at: new Date().toISOString(),
        });
      }
      this._recomputeHostReputation();
      return 'ok';
    }

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
