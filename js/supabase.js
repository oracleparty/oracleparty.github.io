// ============================================
// Oracle Party — Supabase Client (Re-export Hub)
// All domain modules re-exported for backward compatibility.
// ============================================

export { serverFunctionsMissing } from './db/client.js';
export { supabase } from './db/client.js';

// --- Rooms ---
export {
  generateRoomCode, createRoom, findRoomByCode, fetchPublicRooms,
  cleanupOrphanedRooms, cleanupAbandonedRooms, deleteRoom, deleteRoomBeacon, fetchRoom,
  leaveRoomOnServer, leaveRoomBeacon, sweepRoomsOnServer,
  updateRoomStatus, updateGameState, startClockOnServer, saveQuestionIds, appendUsedQuestionIds,
  addRoomScores, fetchRoomScores,
  getServerTimeOffset, testConnection,
  subscribeToRoom, createPresenceChannel, createHonkChannel,
  createTypingChannel, createDifficultyVoteChannel, unsubscribe,
} from './db/rooms.js';

// --- Players & Answers ---
export {
  addPlayer, claimSeat, addBot, promoteToHost, demoteHost, promoteToCohost, demoteCohost,
  removePlayer, removePlayerBeacon, markDisconnectedBeacon, playerHeartbeat,
  fetchPlayers, toggleReady,
  subscribeToPlayers, insertGamePlay, incrementQuestionsAnswered, completeGamePlay,
  submitAnswer, fetchAnswersForQuestion, updateAnswerJudgment,
  fetchAllAnswers, insertBlankAnswers, insertAnswersIfAbsent, upsertAnswers,
  submitAnswerViaServer, fillBlankAnswersViaServer,
  setJudgementOnServer, disqualifyRoundOnServer,
  deleteAnswersByRoom, reassignPlayerAnswers, subscribeToAnswers,
} from './db/players.js';

// --- Questions ---
export {
  fetchCategories, fetchQuestionCount, fetchQuestionsByCategory,
  fetchAllOpenQuestions, fetchExclusiveWildCardQuestions,
  fetchAllOpenQuestionCount, fetchExclusiveWildCardCount,
  fetchQuestionHistoryForUsers, fetchQuestionByDifficulty, fetchQuestionsByIds,
  upsertQuestionHistory, recordRoundHistory, amendQuestionHistory, revokeQuestionHistory,
  fetchMasteryCounts,
  upsertQuestionFeedback, deleteQuestionFeedbackByVoter, fetchQuestionFeedback,
  fetchCategoryPlayCounts, recordQuestionOutcome, recordAnswerText, fetchAnswerTally,
  fetchQuestionPlayStats,
} from './db/questions.js';

// --- Chat ---
export {
  sendMessage, toggleMessageHeart, archiveChatMessages, fetchMessages,
  subscribeToMessages,
} from './db/chat.js';

// --- Social (profiles, friends, leaderboards, titles, settings) ---
export {
  generateDiscriminator, createProfile, fetchProfile, fetchProfileByTag,
  updateProfile, deleteMyAccount, fetchPlayerStats, fetchPlayerStatsBatch,
  fetchGameHistory, insertGameHistoryEntry, searchProfiles,
  fetchTitleUnlocks, upsertTitleUnlock,
  fetchAllPlayerStatsForLeaderboard, fetchPlayerTotalsForLeaderboard, fetchCategoryLeaderboard,
  fetchGameHistorySince, fetchProfilesBatch,
  fetchSiteSettings, upsertSiteSetting, deleteSiteSetting,
  sendFriendRequest, fetchPendingRequests, fetchSentRequests,
  acceptFriendRequest, declineFriendRequest, cancelFriendRequest,
  createFriendship, removeFriend, fetchFriends, isFriend, hasFriends,
  subscribeToFriendRequests,
  fetchAdminAccountDetails, fetchAccountGames, fetchAccountPlayCounts,
} from './db/social.js';
