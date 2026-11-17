import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TokenUsageSettingsSection from '../TokenUsageSettingsSection';

vi.mock('../../../services/chatApi', () => ({
  getTokenUsageSummary: vi.fn().mockResolvedValue({
    today: { date: '2026-11-17', prompt_tokens: 1500, completion_tokens: 600, total_tokens: 2100, request_count: 5 },
    yesterday: { date: '2026-11-16', prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600, request_count: 4 },
    last_7_days: { prompt_tokens: 8000, completion_tokens: 3000, total_tokens: 11000, request_count: 20, avg_daily_tokens: 1571 },
    last_30_days: { prompt_tokens: 25000, completion_tokens: 10000, total_tokens: 35000, request_count: 70, avg_daily_tokens: 1167 },
    all_time: { total_tokens: 50000, total_prompt: 35000, total_completion: 15000, total_requests: 100, active_days: 15 },
    by_provider: [
      { provider: 'openai', prompt_tokens: 20000, completion_tokens: 8000, total_tokens: 28000, request_count: 50, percentage: 56 },
      { provider: 'gemini', prompt_tokens: 15000, completion_tokens: 7000, total_tokens: 22000, request_count: 50, percentage: 44 }
    ],
    by_model: [
      { model: 'gpt-4o', provider: 'openai', total_tokens: 28000, percentage: 56 },
      { model: 'gemini-2.5-flash', provider: 'gemini', total_tokens: 22000, percentage: 44 }
    ],
    daily: [
      { date: '2026-11-17', prompt_tokens: 1500, completion_tokens: 600, total_tokens: 2100, request_count: 5 },
      { date: '2026-11-16', prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600, request_count: 4 }
    ]
  }),
  getDailyTokenUsage: vi.fn().mockResolvedValue([]),
  getTokenUsageLogs: vi.fn().mockResolvedValue([]),
  clearTokenUsage: vi.fn().mockResolvedValue({ success: true }),
}));

describe('TokenUsageSettingsSection', () => {
  it('renders loading skeleton on initial static mount', () => {
    const html = renderToStaticMarkup(<TokenUsageSettingsSection />);
    expect(html).toContain('Token Usage');
    expect(html).toContain('Loading token consumption statistics');
  });
});
