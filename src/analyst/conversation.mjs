// Conversation state.
//
// Bounded on every axis that could otherwise grow without limit:
//
//   turns      a conversation keeps a small window of recent exchanges
//   size       each stored message is truncated
//   count      the number of live conversations is capped
//   time       idle conversations are evicted
//
// Memory only, and never written to disk. Analyst exchanges quote real network
// evidence, so persisting them by default would create a durable record of
// someone's network that the rest of Faultline deliberately avoids keeping.
//
// Tool results are NOT retained across turns. Re-retrieving through a tool
// costs one call and keeps the context small and current; replaying stale
// evidence into every later prompt is how an assistant ends up describing a
// run that has since been superseded.

const MAX_TURNS = 8;
const MAX_CONVERSATIONS = 32;
const MAX_MESSAGE_CHARS = 4_000;
const IDLE_TTL_MS = 60 * 60_000;

export function createConversationStore({
  maxTurns = MAX_TURNS,
  maxConversations = MAX_CONVERSATIONS,
  idleTtlMs = IDLE_TTL_MS,
  now = () => Date.now()
} = {}) {
  /** @type {Map<string, {id: string, createdAt: number, touchedAt: number, turns: Array}>} */
  const conversations = new Map();

  function evict() {
    const cutoff = now() - idleTtlMs;
    for (const [id, entry] of conversations) {
      if (entry.touchedAt < cutoff) conversations.delete(id);
    }
    // Oldest-touched first once over the cap.
    while (conversations.size > maxConversations) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, entry] of conversations) {
        if (entry.touchedAt < oldestAt) {
          oldestAt = entry.touchedAt;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      conversations.delete(oldestId);
    }
  }

  function get(id) {
    evict();
    const entry = conversations.get(id);
    if (!entry) return null;
    entry.touchedAt = now();
    return entry;
  }

  function ensure(id) {
    const existing = get(id);
    if (existing) return existing;
    const entry = { id, createdAt: now(), touchedAt: now(), turns: [] };
    conversations.set(id, entry);
    evict();
    return entry;
  }

  function clip(value) {
    const text = String(value ?? "");
    return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
  }

  return {
    /** Prior turns as chat messages, oldest first. */
    history(id) {
      const entry = get(id);
      if (!entry) return [];
      return entry.turns.flatMap(turn => [
        { role: "user", content: turn.question },
        { role: "assistant", content: turn.answer }
      ]);
    },

    record(id, { question, answer }) {
      const entry = ensure(id);
      entry.turns.push({ question: clip(question), answer: clip(answer), at: now() });
      // Keep the most recent window only.
      if (entry.turns.length > maxTurns) entry.turns = entry.turns.slice(-maxTurns);
      entry.touchedAt = now();
      return entry.turns.length;
    },

    turnCount(id) {
      return get(id)?.turns.length ?? 0;
    },

    clear(id) {
      return conversations.delete(id);
    },

    size() {
      evict();
      return conversations.size;
    },

    reset() {
      conversations.clear();
    }
  };
}

export const conversations = createConversationStore();

export { MAX_TURNS, MAX_CONVERSATIONS, IDLE_TTL_MS };
