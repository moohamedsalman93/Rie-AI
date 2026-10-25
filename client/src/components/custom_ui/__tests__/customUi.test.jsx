import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CustomCard } from "../CustomCard";
import { CustomChart } from "../CustomChart";
import { CustomButtons } from "../CustomButtons";
import { CustomUiContainer } from "../CustomUiContainer";
import { parseMessageContentToBlocks } from "../../../utils/messageParser";
import { MarkdownMessage } from "../../MarkdownMessage";

describe("Custom UI Components", () => {
  it("renders a CustomCard with title, badge, metrics, and items", () => {
    const cardData = {
      title: "Cluster Overview",
      subtitle: "Node 1",
      badge: "Operational",
      badgeVariant: "success",
      description: "All cluster systems operational.",
      metrics: [
        { label: "CPU", value: "32%", change: "+4%" },
        { label: "Memory", value: "8.4 GB", change: "-2%" },
      ],
      items: [
        { label: "Region", value: "us-east-1" },
        { label: "Status", value: "Active" },
      ],
      buttons: [
        { label: "Restart Node", action: "message", value: "Restart Node 1" },
      ],
    };

    const html = renderToStaticMarkup(<CustomCard data={cardData} />);
    expect(html).toContain("Cluster Overview");
    expect(html).toContain("Node 1");
    expect(html).toContain("Operational");
    expect(html).toContain("CPU");
    expect(html).toContain("32%");
    expect(html).toContain("Restart Node");
  });

  it("renders CustomChart with Bar chart data", () => {
    const chartData = {
      type: "bar",
      title: "Monthly Sales",
      data: [
        { label: "Jan", value: 100 },
        { label: "Feb", value: 200 },
      ],
    };

    const html = renderToStaticMarkup(<CustomChart data={chartData} />);
    expect(html).toContain("Monthly Sales");
    expect(html).toContain("Jan");
    expect(html).toContain("Feb");
  });

  it("renders CustomChart with Line and Donut charts", () => {
    const lineData = {
      type: "line",
      title: "Latency",
      data: [
        { label: "10:00", value: 20 },
        { label: "10:05", value: 45 },
      ],
    };
    const donutData = {
      type: "donut",
      title: "Storage",
      data: [
        { label: "Code", value: 40 },
        { label: "Logs", value: 60 },
      ],
    };

    const lineHtml = renderToStaticMarkup(<CustomChart data={lineData} />);
    expect(lineHtml).toContain("Latency");

    const donutHtml = renderToStaticMarkup(<CustomChart data={donutData} />);
    expect(donutHtml).toContain("Storage");
    expect(donutHtml).toContain("Code");
    expect(donutHtml).toContain("Logs");
  });

  it("renders CustomButtons with action items", () => {
    const buttons = [
      { label: "View Logs", action: "message", value: "Show logs" },
      { label: "Open Docs", action: "url", value: "https://docs.example.com" },
    ];

    const html = renderToStaticMarkup(<CustomButtons buttons={buttons} />);
    expect(html).toContain("View Logs");
    expect(html).toContain("Open Docs");
  });

  it("renders CustomUiContainer from raw JSON code string", () => {
    const jsonCode = JSON.stringify({
      type: "card",
      title: "Deployment Summary",
      badge: "Completed",
      description: "Deployment v1.2 is live.",
    });

    const html = renderToStaticMarkup(
      <CustomUiContainer code={jsonCode} type="card" isStreaming={false} />
    );
    expect(html).toContain("Deployment Summary");
    expect(html).toContain("Deployment v1.2 is live.");
  });

  it("parses custom UI XML tags in messageParser", () => {
    const input =
      "Here is the result:\n<chart>{\"type\": \"bar\", \"title\": \"Metrics\", \"data\": [{\"label\": \"A\", \"value\": 10}]}</chart>\nHave a great day!";
    const blocks = parseMessageContentToBlocks(input);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("custom_ui");
    expect(blocks[1].uiType).toBe("chart");
    expect(blocks[1].data.title).toBe("Metrics");
    expect(blocks[2].type).toBe("text");
  });

  it("renders custom UI from code block inside MarkdownMessage", () => {
    const content =
      "Let's inspect the metrics:\n```chart\n{\n  \"type\": \"bar\",\n  \"title\": \"Q1 Growth\",\n  \"data\": [{\"label\": \"Jan\", \"value\": 50}]\n}\n```\nAll done!";

    const html = renderToStaticMarkup(
      <MarkdownMessage content={content} isStreaming={false} />
    );
    expect(html).toContain("Q1 Growth");
    expect(html).toContain("Interactive Chart");
  });

  it("renders an SvgFlowchart with steps and pipeline status", async () => {
    const { SvgFlowchart } = await import("../SvgFlowchart");
    const flowData = {
      title: "Authentication Pipeline",
      steps: [
        { label: "Client Request", description: "Bearer token", status: "completed" },
        { label: "Verify JWT", description: "Validate signature", status: "active" },
        { label: "Access Granted", status: "pending" },
      ],
    };

    const html = renderToStaticMarkup(<SvgFlowchart data={flowData} />);
    expect(html).toContain("Authentication Pipeline");
    expect(html).toContain("Client Request");
    expect(html).toContain("Verify JWT");
    expect(html).toContain("Access Granted");
  });

  it("renders MermaidDiagram container from markdown mermaid block", () => {
    const content =
      "Here is the workflow:\n```mermaid\ngraph TD\n    A[Start] --> B[Process]\n    B --> C[End]\n```\nDone!";

    const html = renderToStaticMarkup(
      <MarkdownMessage content={content} isStreaming={false} />
    );
    expect(html).toContain("Interactive Flowchart / Diagram");
  });

  it("correctly identifies type: flowchart and does NOT misclassify as chart", () => {
    const flowchartJson = JSON.stringify({
      type: "flowchart",
      title: "CI/CD Deployment Pipeline",
      subtitle: "Test -> Build -> Deploy",
      stages: [
        { name: "Test", gates: ["Unit tests", "Linting"] },
        { name: "Build", gates: ["Docker build", "Security scan"] },
        { name: "Deploy", gates: ["Staging deploy", "Prod approval"] },
      ],
    });

    const html = renderToStaticMarkup(
      <CustomUiContainer code={flowchartJson} type="flowchart" isStreaming={false} />
    );
    expect(html).toContain("Interactive Flowchart");
    expect(html).not.toContain("Interactive Chart");
    expect(html).not.toContain("No chart data available");
    expect(html).toContain("CI/CD Deployment Pipeline");
    expect(html).toContain("Test");
    expect(html).toContain("Build");
    expect(html).toContain("Deploy");
    expect(html).toContain("Unit tests");
    expect(html).toContain("Docker build");
  });

  it("renders flowchart via fallback in CustomChart when flowchart data is passed", () => {
    const pipelineData = {
      type: "flowchart",
      title: "Deployment Pipeline",
      stages: [
        { name: "Stage 1", desc: "Build artifact" },
        { name: "Stage 2", desc: "Release" },
      ],
    };

    const html = renderToStaticMarkup(<CustomChart data={pipelineData} />);
    expect(html).not.toContain("No chart data available");
    expect(html).toContain("Stage 1");
    expect(html).toContain("Build artifact");
    expect(html).toContain("Stage 2");
  });

  it("renders Mermaid flowchart with text property and attached buttons", () => {
    const userPayload = {
      status: "rendered",
      type: "flowchart",
      title: "CI/CD Deployment Pipeline",
      subtitle: "Source → Test → Build → Deploy (with gates & rollback)",
      text: "graph TD\n    A[Developer Push] --> B[Test Stage]\n    B --> C[Deploy Stage]",
      buttons: [
        {
          label: "Add Security Scan Stage",
          action: "message",
          value: "Add a security scan stage",
        },
        {
          label: "Simplify to 3 Steps",
          action: "message",
          value: "Simplify to 3 steps",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <CustomUiContainer data={userPayload} type="flowchart" isStreaming={false} />
    );
    expect(html).toContain("Interactive Flowchart");
    expect(html).not.toContain("No flowchart nodes defined");
    expect(html).not.toContain("No chart data available");
    expect(html).toContain("CI/CD Deployment Pipeline");
    expect(html).toContain("Source → Test → Build → Deploy");
    expect(html).toContain("Add Security Scan Stage");
    expect(html).toContain("Simplify to 3 Steps");
  });

  it("sanitizes unquoted special characters in Mermaid code and parses fallback", async () => {
    const { sanitizeMermaid, parseMermaidToFlowchartData } = await import("../MermaidDiagram");
    const rawMermaid = `graph TD
    A[Developer Push / Pull Request] --> B[Source Checkout<br/>Git Clone + Webhook Trigger]
    B --> C{Lint &amp; Static Analysis}
    D --> E{Coverage ≥ Threshold?}
    L --> M{Healthy?}`;

    const sanitized = sanitizeMermaid(rawMermaid);
    expect(sanitized).toContain('C{"Lint & Static Analysis"}');
    expect(sanitized).toContain('E{"Coverage >= Threshold?"}');
    expect(sanitized).toContain('M{"Healthy?"}');
    expect(sanitized).toContain('A["Developer Push / Pull Request"]');

    const fallback = parseMermaidToFlowchartData(rawMermaid, "CI/CD Pipeline");
    expect(fallback).not.toBeNull();
    expect(fallback.steps.length).toBeGreaterThanOrEqual(4);
    expect(fallback.steps.some(s => s.label.includes("Source Checkout"))).toBe(true);
    expect(fallback.steps.some(s => s.label.includes("Coverage"))).toBe(true);
  });

  it("renders complex CI/CD flowchart containing unquoted question marks and ampersands without error", () => {
    const complexPayload = {
      status: "rendered",
      type: "flowchart",
      title: "CI/CD Deployment Pipeline",
      subtitle: "Source → Test → Build → Deploy (with gates & rollback)",
      text: "graph TD\n    A[Developer Push / Pull Request] --> B[Source Checkout<br/>Git Clone + Webhook Trigger]\n    B --> C{Lint &amp; Static Analysis}\n    C -->|Pass| D[TEST STAGE<br/>Unit + Integration Tests]\n    D --> E{Coverage ≥ Threshold?}\n    E -->|Yes| F[BUILD STAGE<br/>Compile / Package Artifact]\n    F --> G[Production Live ✅]",
      buttons: [{ label: "Deploy", action: "message", value: "deploy" }],
    };

    const html = renderToStaticMarkup(
      <CustomUiContainer data={complexPayload} type="flowchart" isStreaming={false} />
    );
    expect(html).not.toContain("Flowchart Syntax Error");
    expect(html).not.toContain("No flowchart nodes defined");
    expect(html).toContain("Interactive Flowchart");
    expect(html).toContain("CI/CD Deployment Pipeline");
    expect(html).toContain("Deploy");
  });

  it("renders MermaidDiagram with draggable container and pan controls", async () => {
    const { MermaidDiagram } = await import("../MermaidDiagram");
    const html = renderToStaticMarkup(
      <MermaidDiagram
        code="graph TD\n A --> B"
        title="Test Pipeline"
        isStreaming={false}
      />
    );
    expect(html).toContain("Test Pipeline");
    expect(html).toContain("Interactive Flowchart / Diagram");
  });
});
