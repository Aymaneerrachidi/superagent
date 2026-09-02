/**
 * Reply matching against a capped conversation.
 *
 * Base44 keeps only the most recent ~200 messages, so the array does not grow:
 * a new message pushes an old one off the front. Any logic based on a message
 * count taken before posting therefore scans past the end and finds the reply
 * never. That was a real bug, and these guard against its return.
 */
import { describe, it, expect } from "vitest";

type Msg = { id: string; role: string; content: string };

/** Mirrors the adapter's matching, which is not exported. */
function newAssistantReplies(messages: Msg[], anchorId: string | null, idsBefore: ReadonlySet<string>) {
  const collect = (from: number) =>
    messages.slice(from).filter((m) => m.role === "assistant" && m.content.trim());

  if (anchorId) {
    const at = messages.findIndex((m) => m.id === anchorId);
    if (at >= 0) return collect(at + 1);
  }
  return messages.filter((m) => m.role === "assistant" && m.content.trim() && !idsBefore.has(m.id));
}

const CAP = 200;

/** A conversation that evicts from the front once full. */
function push(history: Msg[], msg: Msg): Msg[] {
  const next = [...history, msg];
  return next.length > CAP ? next.slice(next.length - CAP) : next;
}

function fullHistory(): Msg[] {
  return Array.from({ length: CAP }, (_, i) => ({ id: `old${i}`, role: "assistant", content: `old ${i}` }));
}

describe("reply matching", () => {
  it("finds the reply when the conversation is already at the cap", () => {
    let convo = fullHistory();
    const idsBefore = new Set(convo.map((m) => m.id));

    convo = push(convo, { id: "mine", role: "user", content: "<CA>" });
    convo = push(convo, { id: "narrate", role: "assistant", content: "Research started." });
    convo = push(convo, { id: "report", role: "assistant", content: '{"status":"completed"}' });

    // The array never grew; the count-based approach would look past the end.
    expect(convo.length).toBe(CAP);

    const found = newAssistantReplies(convo, "mine", idsBefore);
    expect(found.map((m) => m.id)).toEqual(["narrate", "report"]);
  });

  it("finds the reply without an anchor, at the cap", () => {
    // The realistic failure: POST /messages returns no usable id, so there is
    // nothing to anchor on. Falling back to a message count breaks here,
    // because the capped array never grew.
    let convo = fullHistory();
    const idsBefore = new Set(convo.map((m) => m.id));

    convo = push(convo, { id: "mine", role: "user", content: "<CA>" });
    convo = push(convo, { id: "report", role: "assistant", content: '{"status":"completed"}' });
    expect(convo.length).toBe(CAP);

    const found = newAssistantReplies(convo, null, idsBefore);
    expect(found.map((m) => m.id)).toEqual(["report"]);
  });

  it("finds the reply when the anchor id is not in the conversation", () => {
    let convo = fullHistory();
    const idsBefore = new Set(convo.map((m) => m.id));
    convo = push(convo, { id: "mine", role: "user", content: "<CA>" });
    convo = push(convo, { id: "report", role: "assistant", content: '{"status":"completed"}' });

    // An id the API returned that does not appear in the message list.
    const found = newAssistantReplies(convo, "some-other-id", idsBefore);
    expect(found.map((m) => m.id)).toEqual(["report"]);
  });

  it("does not return replies that predate our message", () => {
    let convo = fullHistory();
    convo = push(convo, { id: "stale", role: "assistant", content: '{"status":"completed"}' });
    const idsBefore = new Set(convo.map((m) => m.id));

    convo = push(convo, { id: "mine", role: "user", content: "<CA>" });

    // Nothing new yet: an older report must not be mistaken for the answer.
    expect(newAssistantReplies(convo, "mine", idsBefore)).toEqual([]);
  });

  it("ignores the empty placeholder messages the agent emits", () => {
    let convo = fullHistory();
    const idsBefore = new Set(convo.map((m) => m.id));
    convo = push(convo, { id: "mine", role: "user", content: "<CA>" });
    convo = push(convo, { id: "blank1", role: "assistant", content: "" });
    convo = push(convo, { id: "blank2", role: "assistant", content: "   " });
    convo = push(convo, { id: "report", role: "assistant", content: '{"status":"completed"}' });

    expect(newAssistantReplies(convo, "mine", idsBefore).map((m) => m.id)).toEqual(["report"]);
  });
});
