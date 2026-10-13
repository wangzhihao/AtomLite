import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

mkdirSync('screens', { recursive: true });

export const shot = (page: Page, name: string) => page.screenshot({ path: `screens/${name}.png` });

export const frame = (page: Page) => page.frameLocator('[data-testid=preview-frame]');

/** 从首页用一句话创建项目，并等待第一个版本生成完成 */
export async function createFromHome(page: Page, prompt: string) {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill(prompt);
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('version-tag').first()).toHaveText('版本 1', { timeout: 30_000 });
  return page.url().split('/').pop()!;
}

export async function sendMessage(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('send').click();
}

export async function waitVersion(page: Page, seq: number) {
  await expect(page.getByTestId('version-badge')).toHaveText(`版本 ${seq}`, { timeout: 30_000 });
  await expect(page.getByTestId('live-run')).toHaveCount(0);
}

export const rgb = {
  indigo: 'rgb(79, 70, 229)',
  green: 'rgb(22, 163, 74)',
  red: 'rgb(220, 38, 38)',
};
