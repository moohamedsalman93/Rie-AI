import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModeToggle } from "../ModeToggle";

describe("ModeToggle component", () => {
  it("renders trigger button with current mode label", () => {
    const htmlAgent = renderToStaticMarkup(
      <ModeToggle chatMode="agent" provider="azure_foundry" speedMode="thinking" />
    );
    expect(htmlAgent).toContain("Agent");

    const htmlCoding = renderToStaticMarkup(
      <ModeToggle chatMode="coding" provider="azure_foundry" speedMode="thinking" />
    );
    expect(htmlCoding).toContain("Code");

    const htmlChat = renderToStaticMarkup(
      <ModeToggle chatMode="chat" provider="azure_foundry" speedMode="thinking" />
    );
    expect(htmlChat).toContain("Chat");
  });

  it("forces chat mode label when provider is 'rie'", () => {
    const html = renderToStaticMarkup(
      <ModeToggle chatMode="coding" provider="rie" speedMode="thinking" />
    );
    expect(html).toContain("Chat");
  });

  it("renders speed toggle buttons", () => {
    const html = renderToStaticMarkup(
      <ModeToggle
        chatMode="coding"
        provider="azure_foundry"
        speedMode="thinking"
        setSpeedMode={vi.fn()}
      />
    );
    expect(html).toContain("🧠");
    expect(html).toContain("⚡");
  });
});
