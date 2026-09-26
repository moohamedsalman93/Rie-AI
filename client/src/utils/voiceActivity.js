// Events carry complete snapshots; repeated updates replace the same row.
export function upsertVoiceActivity(items, update, limit = 100) {
  const index = items.findIndex((item) => item.id === update.id);
  if (index < 0) {
    const next = [...items, update];
    while (next.length > limit) {
      // Never evict a running action or a caption still being transcribed.
      const oldest = next.findIndex((item) => item.id !== update.id && !item.isPartial && !["running", "queued"].includes(item.status));
      if (oldest < 0) break;
      next.splice(oldest, 1);
    }
    return next;
  }
  const next = [...items];
  next[index] = { ...items[index], ...update };
  return next;
}

export function upsertVoiceMessage(messages, transcript) {
  const index = messages.findIndex((message) => message.id === transcript.id);
  const message = {
    id: transcript.id,
    from: transcript.role === "user" ? "user" : "bot",
    text: transcript.text,
    isPartial: transcript.isPartial,
    interrupted: transcript.interrupted,
    timestamp: index >= 0 ? messages[index].timestamp : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
  if (index < 0) return [...messages, message];
  return messages.map((item, i) => i === index ? { ...item, ...message } : item);
}

// Tool calls share the chat timeline with captions. Results update their call
// row, even when they arrive after another transcript or out of order.
export function upsertVoiceToolMessage(messages, event) {
  if (!event.id) return messages;
  const id = `voice-tool:${event.id}`;
  const index = messages.findIndex((message) => message.id === id);
  const previous = index >= 0 ? messages[index] : null;
  const message = {
    ...previous,
    id,
    from: "bot",
    text: "",
    blocks: [{ ...previous?.blocks?.[0], ...event, type: "voice_tool" }],
    timestamp: previous?.timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
  if (index < 0) return [...messages, message];
  return messages.map((item, i) => i === index ? message : item);
}

// Subagent jobs stream live status, tool calls, and completion/cancellation
export function upsertVoiceJobMessage(messages, jobEvent) {
  if (!jobEvent.job_id) return messages;
  const id = `voice-job:${jobEvent.job_id}`;
  const index = messages.findIndex((message) => message.id === id);
  const previous = index >= 0 ? messages[index] : null;
  const prevBlock = previous?.blocks?.[0] || {};

  const events = [...(prevBlock.events || [])];
  if (jobEvent.event && (!events.length || events[events.length - 1] !== jobEvent.event)) {
    events.push(jobEvent.event);
  }

  const status = jobEvent.status || prevBlock.status || "running";

  const message = {
    ...previous,
    id,
    from: "bot",
    text: "",
    blocks: [
      {
        ...prevBlock,
        type: "voice_subagent",
        id: jobEvent.job_id,
        job_id: jobEvent.job_id,
        task: jobEvent.task || prevBlock.task || "Autonomous execution task",
        status,
        latest_event: jobEvent.event || prevBlock.latest_event || "Subagent running...",
        events,
        tool_name: jobEvent.tool_name || prevBlock.tool_name,
        tool_args: jobEvent.tool_args || prevBlock.tool_args,
        result: jobEvent.result || prevBlock.result,
      },
    ],
    timestamp: previous?.timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };

  if (index < 0) return [...messages, message];
  return messages.map((item, i) => (i === index ? message : item));
}
