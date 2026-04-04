// ============================================
// Oracle Party — Host Promotion Helper
// Pure function for deterministic host selection.
// ============================================

/**
 * Determine which player should become host next.
 * Returns null if a host already exists.
 * Prefers co-host, then falls back to earliest joined player.
 */
export function determineNextHost(players) {
  if (!players || players.length === 0) return null;
  if (players.some(p => p.is_host)) return null;
  const cohost = players.find(p => p.is_cohost);
  if (cohost) return cohost;
  const sorted = [...players].sort((a, b) => {
    const ta = a.joined_at ? new Date(a.joined_at).getTime() : Infinity;
    const tb = b.joined_at ? new Date(b.joined_at).getTime() : Infinity;
    return ta - tb;
  });
  return sorted[0] || null;
}
