#!/usr/bin/env npx tsx
/**
 * X Integration - Get Trending Topics
 * Scrapes trending topics from X Explore page using the persistent Chrome profile.
 * Usage: echo '{}' | npx tsx trends.ts
 */

import { getBrowserContext, runScript, ScriptResult } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface TrendsInput {
  limit?: number;
}

interface Trend {
  name: string;
  category?: string;
  postCount?: string;
}

async function getTrends(input: TrendsInput): Promise<ScriptResult> {
  const limit = input.limit ?? 20;
  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/explore/tabs/trending', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
      .isVisible()
      .catch(() => false);
    if (!isLoggedIn) {
      return {
        success: false,
        message: 'X login expired. Run the x-integration setup script to re-authenticate.',
      };
    }

    // Wait for trending content to load
    await page
      .waitForSelector('[data-testid="trend"]', { timeout: config.timeouts.elementWait * 2 })
      .catch(() => {});

    // Extract trending items
    const trends: Trend[] = await page.evaluate((maxItems: number) => {
      const trendElements = document.querySelectorAll('[data-testid="trend"]');
      const results: Trend[] = [];

      trendElements.forEach((el) => {
        // innerText gives lines like: "1\n·\nTrending in United States\n#TopicName"
        // The trend name is always the last non-empty line.
        const lines = (el as HTMLElement).innerText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const name = lines[lines.length - 1];
        if (!name || name === '·' || /^\d+$/.test(name)) return;

        // Look for "posts" count among lines
        const postCount = lines.find(
          (l) => l.includes('K posts') || l.includes('M posts') || l.includes(' posts'),
        );

        // Category: a line containing "Trending in" or just "Trending"
        const categoryLine = lines.find((l) => l.toLowerCase().includes('trending'));
        const category = categoryLine?.replace(/^Trending\s*(in\s*)?/i, '').trim() || undefined;

        results.push({ name, postCount, category: category || undefined });
      });

      return results.slice(0, maxItems);
    }, limit);

    if (trends.length === 0) {
      // Fallback: try the standard Explore tab
      await page.goto('https://x.com/explore', {
        timeout: config.timeouts.navigation,
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(config.timeouts.pageLoad);

      const fallbackTrends: Trend[] = await page.evaluate((maxItems: number) => {
        const trendElements = document.querySelectorAll('[data-testid="trend"]');
        const results: Trend[] = [];
        trendElements.forEach((el) => {
          const lines = (el as HTMLElement).innerText
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          const name = lines[lines.length - 1];
          if (name && name !== '·' && !/^\d+$/.test(name)) results.push({ name });
        });
        return results.slice(0, maxItems);
      }, limit);

      if (fallbackTrends.length === 0) {
        return {
          success: false,
          message: 'Could not extract trending topics — X may have updated its layout.',
        };
      }

      return {
        success: true,
        message: `Found ${fallbackTrends.length} trending topics`,
        data: fallbackTrends,
      };
    }

    return {
      success: true,
      message: `Found ${trends.length} trending topics`,
      data: trends,
    };
  } finally {
    if (context) await context.close();
  }
}

runScript<TrendsInput>(getTrends);
