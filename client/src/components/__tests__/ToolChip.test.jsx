import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCallGroup, ToolChip } from "../ToolChip";

describe("ToolCallGroup component", () => {
  const sampleBlocks = [
    { name: "view_file", text: "file content" },
    { name: "write_file", text: "written content" },
    { name: "grep_search", text: "search results" },
    { name: "list_directory", text: "dir contents" },
  ];

  it("renders collapsed group without box cutout and with wrench icon", () => {
    const html = renderToStaticMarkup(<ToolCallGroup blocks={sampleBlocks} />);
    
    // Label check
    expect(html).toContain("Ran 4 tools");
    
    // No box cutout styling (no container card border/background)
    expect(html).not.toContain("bg-neutral-900/50");
    expect(html).not.toContain("border-neutral-800/80 rounded-lg");
    
    // Uses lucide wrench icon
    expect(html).toContain("lucide-wrench");
    
    // Uses lucide chevron down icon when collapsed
    expect(html).toContain("lucide-chevron-down");
  });

  it("renders direct chips when blocks count is less than 3", () => {
    const html = renderToStaticMarkup(
      <ToolCallGroup
        blocks={[
          { name: "view_file", text: "content 1" },
          { name: "write_file", text: "content 2" },
        ]}
      />
    );
    expect(html).toContain("Viewed file");
    expect(html).toContain("Wrote to file");
    expect(html).not.toContain("Ran 2 tools");
  });
});

describe("ToolChip component", () => {
  it("renders tool name and wrench icon", () => {
    const html = renderToStaticMarkup(
      <ToolChip name="run_terminal_command" content="ls output" />
    );
    expect(html).toContain("Ran terminal command");
    expect(html).toContain("lucide-wrench");
  });
});
