// ============================================
// Oracle Party — Game Chat Module
// Chat bar, drawer, messages, typing indicator.
// ============================================

import { state } from './state.js';
import { $, escapeHtml, renderAvatar } from '../utils.js';
import { fetchMessages, sendMessage, toggleMessageHeart } from '../supabase.js';
import { getDisplayName } from '../auth.js';
import { notifyTyping } from '../typing.js';
import { setHonkMuted } from '../honk.js';

// ============================================
// CHAT BAR + DRAWER
// ============================================

/**
 * Move the chat bar + drawer into the active screen's game-body
 * so they participate in the normal flex layout (no fixed overlay).
 */
export function repositionChatBar() {
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) return;
  const gameBody = activeScreen.querySelector('.game-body');
  if (!gameBody) return;
  const header = activeScreen.querySelector('.game-header');
  const bar = $('#chat-bar');
  const drawer = $('#chat-drawer');

  // Move bar + drawer into game-body after header (inline flex flow)
  if (header && bar.parentNode !== gameBody) {
    header.after(bar);
    bar.after(drawer);
  }
}

export function showChatBar() {
  $('#chat-bar').classList.remove('hidden');
  setHonkMuted(false);

  // Restore accumulated unread badge
  if (state.unreadCount > 0 && !state.chatOpen) {
    const badge = $('#chat-bar-badge');
    badge.textContent = state.unreadCount;
    badge.classList.remove('hidden');
  }

  repositionChatBar();
  // Reposition after screen transition completes (DOM may not be ready yet)
  requestAnimationFrame(repositionChatBar);
}

export function hideChatBar() {
  closeChatDrawer();
  $('#chat-bar').classList.add('hidden');
  setHonkMuted(true);
}

export function attachChatListeners() {
  $('#chat-bar').addEventListener('click', toggleChatDrawer);
  $('#btn-chat-send').addEventListener('click', handleSendGameChat);
  $('#chat-drawer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendGameChat();
  });
  $('#chat-drawer-input').addEventListener('input', notifyTyping);

  // Close button inside the drawer
  $('#chat-drawer-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeChatDrawer();
  });

  // Heart button click handler (event delegation on message container)
  $('#chat-drawer-messages').addEventListener('click', async (e) => {
    const heartBtn = e.target.closest('.heart-btn');
    if (!heartBtn) return;
    e.stopPropagation();
    const bubble = heartBtn.closest('.chat-bubble');
    const msgId = bubble?.dataset.msgId;
    if (!msgId) return;
    // Optimistic toggle
    const iHearted = heartBtn.classList.contains('hearted');
    heartBtn.classList.toggle('hearted', !iHearted);
    const countEl = bubble.querySelector('.heart-count');
    let count = parseInt(countEl.textContent, 10) || 0;
    count += iHearted ? -1 : 1;
    countEl.textContent = count;
    countEl.classList.toggle('hidden', count <= 0);
    // Persist
    await toggleMessageHeart(msgId, getDisplayName());
  });
}

function toggleChatDrawer() {
  if (state.chatOpen) {
    closeChatDrawer();
  } else {
    state.chatOpen = true;
    $('#chat-bar').classList.add('open');
    $('#chat-drawer').classList.add('open');
    scrollGameChatToBottom();
    setTimeout(() => $('#chat-drawer-input').focus({ preventScroll: true }), 300);
    state.unreadCount = 0;
    const badge = $('#chat-bar-badge');
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

/** Append a local-only notice to the chat drawer (not sent to DB). */
export function _appendLocalChatNotice(text) {
  const messagesEl = $('#chat-drawer-messages');
  if (!messagesEl) return;
  const notice = document.createElement('div');
  notice.className = 'chat-msg chat-msg--system';
  notice.textContent = text;
  messagesEl.appendChild(notice);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export function closeChatDrawer() {
  state.chatOpen = false;
  $('#chat-bar').classList.remove('open');
  $('#chat-drawer').classList.remove('open');
}

export async function loadChatMessages() {
  const messages = await fetchMessages(state.room.id);
  const container = $('#chat-drawer-messages');
  container.innerHTML = '';
  for (const msg of messages) {
    if (msg.player_name === 'System') {
      addGameSystemMessage(msg.message);
    } else {
      appendGameChatMessage(msg.player_name, msg.message, msg.id, msg.hearts);
    }
  }
  scrollGameChatToBottom();

  // Show latest message preview in bar
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    updateChatBarPreview(last.player_name, last.message);
  }
}

export function handleNewMessage(payload) {
  if (!payload.new) return;

  // Handle UPDATE events (heart changes)
  if (payload.eventType === 'UPDATE') {
    const { id, hearts } = payload.new;
    if (!id) return;
    const bubble = document.querySelector(`[data-msg-id="${id}"]`);
    if (bubble) updateHeartDisplay(bubble, hearts);
    return;
  }

  const { player_name, message, id, hearts } = payload.new;

  // Dedup: skip Realtime echoes of our own optimistic appends
  if (player_name === getDisplayName() && state.chatEchoPending > 0) {
    state.chatEchoPending--;
    // Still assign the message ID to the optimistic bubble (first unassigned = earliest sent)
    if (id) {
      const first = $('#chat-drawer-messages')?.querySelector('.chat-bubble:not([data-msg-id])');
      if (first) first.dataset.msgId = id;
    }
    return;
  }

  // System messages get distinct styling (no avatar, centered, accent color)
  if (player_name === 'System') {
    addGameSystemMessage(message);
    // Detect disqualify messages from host
    const dqMatch = message.match(/^Host disqualified Q(\d+)/);
    if (dqMatch) {
      const dqQNum = parseInt(dqMatch[1], 10) - 1; // 0-indexed
      state.disqualifiedQuestions.add(dqQNum);
      // Refund this player's wager for the disqualified round.
      // Filter by question_number to handle late-arriving messages (after currentQuestion advances).
      const myAnswer = state.currentAnswers.find(a =>
        String(a.player_id) === String(state.room.playerId) &&
        a.question_number === dqQNum
      );
      if (myAnswer?.wager) state.usedWagers.delete(myAnswer.wager);
    }
  } else {
    appendGameChatMessage(player_name, message, id, hearts);
    scrollGameChatToBottom();
  }

  // Always update the bar preview with the latest message
  updateChatBarPreview(player_name, message);

  // Track unread + flash bar when drawer is closed
  if (!state.chatOpen) {
    state.unreadCount = (state.unreadCount || 0) + 1;

    const chatHidden = $('#chat-bar').classList.contains('hidden');
    if (!chatHidden) {
      const badge = $('#chat-bar-badge');
      badge.textContent = state.unreadCount;
      badge.classList.remove('hidden');
      flashChatBar();
    }
  }
}

function updateChatBarPreview(name, text) {
  const preview = $('#chat-bar-preview');
  if (!preview) return;
  const truncated = text.length > 35 ? text.slice(0, 35) + '\u2026' : text;
  preview.innerHTML = `<span class="chat-bar__preview-name">${escapeHtml(name)}:</span> ${escapeHtml(truncated)}`;
}

function flashChatBar() {
  const bar = $('#chat-bar');
  bar.classList.remove('chat-bar--flash');
  // Force reflow to restart animation
  void bar.offsetHeight;
  bar.classList.add('chat-bar--flash');
}

function appendGameChatMessage(name, text, msgId = null, hearts = []) {
  const player = state.players.find(p => p.display_name === name);
  const chatAvatar = renderAvatar({ displayName: name, avatarColor: player?.avatar_color || null, avatarEmoji: player?.avatar_emoji || null, extraClass: 'avatar--chat' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (msgId) bubble.dataset.msgId = msgId;
  const heartCount = Array.isArray(hearts) ? hearts.length : 0;
  const iHearted = Array.isArray(hearts) && hearts.includes(getDisplayName());
  bubble.innerHTML = `
    <div class="chat-bubble__header">${chatAvatar}<div class="chat-bubble__name">${escapeHtml(name)}</div></div>
    <div class="chat-bubble__body">
      <div class="chat-bubble__text">${escapeHtml(text)}</div>
      <div class="chat-bubble__hearts">
        <button class="heart-btn${iHearted ? ' hearted' : ''}" aria-label="Heart">&hearts;</button>
        <span class="heart-count${heartCount === 0 ? ' hidden' : ''}">${heartCount}</span>
      </div>
    </div>
  `;
  $('#chat-drawer-messages').appendChild(bubble);
}

export function addGameSystemMessage(text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble--system';
  bubble.innerHTML = `<div class="chat-bubble__text">${escapeHtml(text)}</div>`;
  $('#chat-drawer-messages').appendChild(bubble);
  scrollGameChatToBottom();
}

function scrollGameChatToBottom() {
  const container = $('#chat-drawer-messages');
  container.scrollTop = container.scrollHeight;
}

function updateHeartDisplay(bubble, hearts) {
  const arr = Array.isArray(hearts) ? hearts : [];
  const btn = bubble.querySelector('.heart-btn');
  const countEl = bubble.querySelector('.heart-count');
  if (!btn || !countEl) return;
  btn.classList.toggle('hearted', arr.includes(getDisplayName()));
  countEl.textContent = arr.length;
  countEl.classList.toggle('hidden', arr.length === 0);
}

export async function handleSendGameChat() {
  const input = $('#chat-drawer-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const name = getDisplayName();

  // Optimistic append
  appendGameChatMessage(name, text);
  scrollGameChatToBottom();
  updateChatBarPreview(name, text);

  state.chatEchoPending = (state.chatEchoPending || 0) + 1;

  try {
    const { data } = await sendMessage(state.room.id, name, text);
    // Assign real ID to the optimistic bubble so hearts work (first unassigned = earliest)
    if (data?.id) {
      const first = $('#chat-drawer-messages')?.querySelector('.chat-bubble:not([data-msg-id])');
      if (first) first.dataset.msgId = data.id;
    }
  } catch {
    state.chatEchoPending = Math.max(0, (state.chatEchoPending || 0) - 1);
  }
}

export function updateTypingUI(typerNames) {
  const el = $('#typing-indicator');
  if (!el) return;
  if (typerNames.length === 0) {
    el.classList.remove('active');
  } else {
    const text = typerNames.length === 1
      ? `${typerNames[0]} is typing\u2026`
      : typerNames.length === 2
        ? `${typerNames[0]} and ${typerNames[1]} are typing\u2026`
        : `${typerNames[0]} and ${typerNames.length - 1} others are typing\u2026`;
    el.textContent = text;
    el.classList.add('active');
  }
}
