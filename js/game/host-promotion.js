// ============================================
// Oracle Party — Host Promotion Helper
// Pure function for deterministic host selection.
// ============================================

/**
 * Determine which player should become host next.
 *
 * @param players   every player in the room
 * @param absentIds ids considered gone right now (phone asleep, tab switched,
 *                  connection dropped). Absent players can neither hold the
 *                  role nor inherit it.
 *
 * Returns null when a present host already exists, or when the caller is not
 * the right person to take over.
 *
 * A host whose browser dies keeps is_host set on their row until it is
 * removed, which is gated on a three-minute silence threshold. Treating that
 * flag as proof of a working host left the room frozen for the whole three
 * minutes, so an absent host is ignored for succession while their row stays
 * put for a seamless rejoin.
 *
 * Order: co-host first — they are the designated heir and can already advance
 * the game — then the longest-present player.
 */
export function determineNextHost(players, absentIds = new Set()) {
  if (!players || players.length === 0) return null;

  const isPresent = p => !absentIds.has(String(p.id));

  // A present host means there is nothing to do.
  if (players.some(p => p.is_host && isPresent(p))) return null;

  const candidates = players.filter(isPresent);
  if (candidates.length === 0) return null;   // everyone is gone; nobody to promote

  const cohost = candidates.find(p => p.is_cohost);
  if (cohost) return cohost;

  const sorted = [...candidates].sort((a, b) => {
    const ta = a.joined_at ? new Date(a.joined_at).getTime() : Infinity;
    const tb = b.joined_at ? new Date(b.joined_at).getTime() : Infinity;
    return ta - tb;
  });
  return sorted[0] || null;
}

/**
 * Players who have gone quiet for longer than `thresholdMs`.
 *
 * A missing timestamp means "cannot tell", never "absent" — last_seen_at did
 * not exist on the live database for a long time, and reading undefined as
 * absent got every player kicked seconds after joining.
 */
export function findAbsentPlayers(players, thresholdMs, now = Date.now()) {
  const absent = new Set();
  for (const p of players || []) {
    const raw = p.last_seen_at;
    if (!raw) continue;
    if (now - new Date(raw).getTime() > thresholdMs) absent.add(String(p.id));
  }
  return absent;
}
