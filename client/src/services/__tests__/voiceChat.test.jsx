import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertVoiceJobMessage, upsertVoiceMessage, upsertVoiceToolMessage } from "../../utils/voiceActivity";
import { ChatMessages } from "../../components/ChatMessages";
import { ChatInputArea } from "../../components/ChatInputArea";
import { NormalModeLayout } from "../../components/NormalModeLayout";
import VoiceControls from "../../components/VoiceControls";
import VoiceToolActivity from "../../components/VoiceToolActivity";
import VoiceSubAgentActivity from "../../components/VoiceSubAgentActivity";

vi.mock("../chatApi", () => ({
  API_BASE_URL: "http://localhost:8000", getAppToken: () => "test",
  getHistory: vi.fn(), getBrowserStatus: vi.fn(),
}));

function conversation() {
  let messages = upsertVoiceMessage([], { id: "u1", role: "user", text: "Open the docs", isPartial: false });
  messages = upsertVoiceToolMessage(messages, { id: "t1", name: "browser_open", status: "running", args: { url: "https://example.com/docs" } });
  messages = upsertVoiceMessage(messages, { id: "a1", role: "assistant", text: "Opening", isPartial: true });
  messages = upsertVoiceToolMessage(messages, { id: "t1", status: "completed", result: "Opened documentation" });
  return upsertVoiceMessage(messages, { id: "a1", role: "assistant", text: "The docs are open.", isPartial: false });
}

describe("voice in the chat timeline", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("keeps one row per caption/tool, with stable order, input and results", () => {
    const messages = conversation();
    expect(messages.map(({ id }) => id)).toEqual(["u1", "voice-tool:t1", "a1"]);
    expect(messages[1].blocks[0]).toMatchObject({ type: "voice_tool", status: "completed", args: { url: "https://example.com/docs" }, result: "Opened documentation" });
    expect(messages[2].text).toBe("The docs are open.");
    expect(messages[2].isPartial).toBe(false);
  });

  it("correlates out-of-order failures and cancellations without losing other turns", () => {
    let messages = conversation();
    messages = upsertVoiceToolMessage(messages, { id: "t2", name: "internet_search", status: "running", args: { query: "testing" } });
    messages = upsertVoiceToolMessage(messages, { id: "t1", status: "failed", result: "Browser unavailable" });
    messages = upsertVoiceToolMessage(messages, { id: "t2", status: "cancelled", result: "Call ended" });
    expect(messages).toHaveLength(4);
    expect(messages[1].blocks[0].status).toBe("failed");
    expect(messages[3].blocks[0]).toMatchObject({ status: "cancelled", args: { query: "testing" } });
    expect(upsertVoiceToolMessage(messages, { status: "running" })).toBe(messages);
  });

  it("shows captions and expandable tool results in the floating conversation", () => {
    const html = renderToStaticMarkup(<ChatMessages messages={conversation()} isVoiceActive />);
    expect(html).toContain("Open the docs");
    expect(html).toContain("The docs are open.");
    expect(html).toContain("<details");
    expect(html).toContain("Opened documentation");
    expect(html).toContain("https://example.com/docs");
  });

  it("replaces only the composer with accessible controls, then restores the draft", () => {
    const props = { input: "Keep my draft", setInput: vi.fn() };
    const html = renderToStaticMarkup(<ChatInputArea {...props} voiceControls={{ status: "listening", isMuted: true }} />);
    expect(html).toContain('aria-label="Voice controls"');
    expect(html).toContain('aria-label="Unmute microphone"');
    expect(html).toContain('aria-label="End voice conversation"');
    expect(html).toContain("Microphone off");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<details");
    const ended = renderToStaticMarkup(<ChatInputArea {...props} />);
    expect(ended).toContain("<textarea");
    expect(ended).toContain("Keep my draft");
    expect(ended).not.toContain('aria-label="Voice controls"');
  });

  it("uses the same timeline and bottom controls in normal mode", () => {
    const html = renderToStaticMarkup(<NormalModeLayout messages={conversation()} input="" terminalLogs={[]} voiceControls={{ status: "listening" }} />);
    expect(html).toContain("Open the docs");
    expect(html).toContain("Opened documentation");
    expect(html).toContain("The docs are open.");
    expect(html.match(/aria-label="Voice controls"/g)).toHaveLength(1);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Transcript &amp; activity");
  });

  it("does not hide pending replies or playback behind microphone-off status", () => {
    for (const [status, label] of [["thinking", "Rie is thinking"], ["speaking", "Rie is speaking"]]) {
      const html = renderToStaticMarkup(<VoiceControls status={status} isMuted />);
      expect(html).toContain(label);
      expect(html).toContain("Microphone off · You can still hear Rie");
      expect(html).toContain('aria-label="Unmute microphone"');
    }
  });

  it("labels a finished search as a result rather than Searching", () => {
    const html = renderToStaticMarkup(<VoiceToolActivity item={{ name: "internet_search", status: "completed", result: "Found the answer" }} />);
    expect(html).toContain("Web search");
    expect(html).toContain("Done");
    expect(html).not.toContain("Searching...");
  });

  it("updates and renders autonomous subagent status, tool calling, and cancel button", () => {
    let messages = [];
    messages = upsertVoiceJobMessage(messages, {
      job_id: "job_test_123",
      task: "Fix tests and build project",
      status: "running",
      event: "Running command: npm test",
      tool_name: "run_terminal_command",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0]).toMatchObject({
      type: "voice_subagent",
      job_id: "job_test_123",
      task: "Fix tests and build project",
      status: "running",
      latest_event: "Running command: npm test",
    });

    // Update with another tool call event
    messages = upsertVoiceJobMessage(messages, {
      job_id: "job_test_123",
      status: "running",
      event: "Editing file: src/App.jsx",
      tool_name: "edit_file",
    });

    expect(messages[0].blocks[0].events).toEqual([
      "Running command: npm test",
      "Editing file: src/App.jsx",
    ]);

    const html = renderToStaticMarkup(
      <ChatMessages messages={messages} isVoiceActive onCancelSubAgent={vi.fn()} />
    );
    expect(html).toContain("Autonomous Subagent");
    expect(html).toContain("job_test_123");
    expect(html).toContain("Fix tests and build project");
    expect(html).toContain("Working");
    expect(html).toContain("Cancel");
    expect(html).toContain("Editing file: src/App.jsx");

    // Complete the job
    messages = upsertVoiceJobMessage(messages, {
      job_id: "job_test_123",
      status: "completed",
      result: "All 54 tests passed.",
    });

    const completedHtml = renderToStaticMarkup(
      <ChatMessages messages={messages} isVoiceActive />
    );
    expect(completedHtml).toContain("Done");
    expect(completedHtml).not.toContain("Cancel");
  });
});
