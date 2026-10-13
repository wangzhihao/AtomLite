import { expect, test } from '@playwright/test';
import { createFromHome, sendMessage, waitVersion } from './helpers';

/** 生成过程的进度展示：步骤条、计时与输出量、文件进度、思路摘要、慢响应提示 */

const steps = (page: import('@playwright/test').Page) =>
  page.getByTestId('progress-step').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-step')}:${el.getAttribute('data-status')}`));

test('新建：步骤条逐步推进，状态行显示在做什么、用时、输出量和文件进度', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[slow] 做一个进度测试');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByTestId('follow-toggle').uncheck(); // 留在预览，便于观察时间线

  const bar = page.getByTestId('progress-bar');
  await expect(bar).toBeVisible();
  await expect.poll(() => steps(page)).toEqual(expect.arrayContaining(['plan:done', 'design:done', 'code:active']));
  expect((await steps(page)).map((s) => s.split(':')[0])).toEqual(['plan', 'design', 'code', 'check', 'save', 'suggest']);

  const status = page.getByTestId('progress-status');
  await expect(status).toContainText(/Kai 正在(思考|说明方案|写 )/);
  await expect(status).toContainText('tokens');
  await expect(page.getByTestId('progress-typical')).toContainText('通常约');
  // 计时在走
  const t1 = await page.getByTestId('progress-elapsed').innerText();
  await expect.poll(() => page.getByTestId('progress-elapsed').innerText(), { timeout: 5000 }).not.toBe(t1);
  // 文件进度来自 Nora 的文件计划（App.jsx、app.json）
  await expect(page.getByTestId('progress-files')).toContainText(/文件 \d\/2/, { timeout: 30_000 });
  await page.screenshot({ path: 'screens/30-progress.png' });
  await waitVersion(page, 1);
  await expect(page.getByTestId('progress-bar')).toHaveCount(0);
});

test('修改：步骤只有编码 → 检查 → 保存 → 建议', async ({ page }) => {
  await createFromHome(page, '做一个修改进度测试');
  await page.getByTestId('follow-toggle').uncheck();
  await sendMessage(page, '[slow] 主色改成绿色');
  await expect.poll(async () => (await steps(page)).map((s) => s.split(':')[0])).toEqual(['code', 'check', 'save', 'suggest']);
  await waitVersion(page, 2);
});

test('思路摘要：生成中实时出现，完成后折叠保存，可展开', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[slow] 做一个思路测试');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByTestId('follow-toggle').uncheck();
  const live = page.getByTestId('live-run').getByTestId('thinking');
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(live).toContainText('思路');
  await waitVersion(page, 1);

  await page.reload();
  const saved = page.getByTestId('msg-engineer').getByTestId('thinking');
  await expect(saved).toHaveAttribute('aria-expanded', 'false');
  await expect(saved.getByTestId('thinking-text')).toHaveClass(/line-clamp-1/);
  await saved.click();
  await expect(saved).toHaveAttribute('aria-expanded', 'true');
  await expect(saved.getByTestId('thinking-text')).toContainText('数据结构');
  await expect(saved.getByTestId('thinking-text')).toContainText('design.json');
});

test('模型长时间没有输出时提示“响应较慢”，恢复输出后提示消失', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[stall] 做一个慢响应测试');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByTestId('follow-toggle').uncheck();
  const stall = page.getByTestId('progress-stall');
  await expect(stall).toBeVisible({ timeout: 15_000 });
  await expect(stall).toContainText('连接正常，仍在等待');
  await page.screenshot({ path: 'screens/31-stall.png' });
  await expect(stall).toHaveCount(0, { timeout: 15_000 });
  await waitVersion(page, 1);
});
