// ============================================
// Oracle Party — Supabase Client (Re-export Hub)
// All domain modules re-exported for backward compatibility.
// ============================================

export { supabase } from './db/client.js';

// --- Rooms ---
export {
  generateRoomCode, createRoom, findRoomByCode, fetchPublicRooms,
  cleanupOrphanedRooms, deleteRoom, deleteRoomBeacon, fetchRoom,
  updateRoomStatus, updateGameState, saveQuestionIds, appendUsedQuestionIds,
  getServerTimeOffset, testConnection,
  subscribeToRoom, createPresenceChannel, createHonkChannel,
  createTypingChannel, createDifficultyVoteChannel, unsubscribe,
} from './db/rooms.js';

// --- Players & Answers ---
export {
  addPlayer, promoteToHost, demoteHost, promoteToCohost, demoteCohost,
  removePlayer, removePlayerBeacon, markDisconnectedBeacon, playerHeartbeat,
  fetchPlayers, toggleReady,
  subscribeToPlayers, insertGamePlay, incrementQuestionsAnswered, completeGamePlay,
  submitAnswer, fetchAnswersForQuestion, updateAnswerJudgment,
  fetchAllAnswers, deleteAnswersByRoom, reassignPlayerAnswers, subscribeToAnswers,
} from './db/players.js';

// --- Questions ---
export {
  fetchCategories, fetchQuestionCount, fetchQuestionsByCategory,
  fetchAllOpenQuestions, fetchExclusiveWildCardQuestions,
  fetchAllOpenQuestionCount, fetchExclusiveWildCardCount,
  fetchQuestionHistoryForUsers, fetchQuestionByDifficulty, fetchQuestionsByIds,
  upsertQuestionHistory, fetchMasteryCounts,
  upsertQuestionFeedback, deleteQuestionFeedback, fetchQuestionFeedback,
  fetchCategoryPlayCounts, recordQuestionOutcome,
} from './db/questions.js';

// --- Chat ---
export {
  sendMessage, toggleMessageHeart, archiveChatMessages, fetchMessages,
  subscribeToMessages,
} from './db/chat.js';

// --- Social (profiles, friends, leaderboards, titles, settings) ---
export {
  generateDiscriminator, createProfile, fetchProfile, fetchProfileByTag,
  updateProfile, fetchPlayerStats, fetchPlayerStatsBatch,
  fetchGameHistory, insertGameHistoryEntry, searchProfiles,
  fetchTitleUnlocks, upsertTitleUnlock,
  fetchAllPlayerStatsForLeaderboard, fetchCategoryLeaderboard,
  fetchGameHistorySince, fetchProfilesBatch,
  fetchSiteSettings, upsertSiteSetting, deleteSiteSetting,
  sendFriendRequest, fetchPendingRequests, fetchSentRequests,
  acceptFriendRequest, declineFriendRequest, cancelFriendRequest,
  createFriendship, removeFriend, fetchFriends, isFriend, hasFriends,
  subscribeToFriendRequests,
} from './db/social.js';
