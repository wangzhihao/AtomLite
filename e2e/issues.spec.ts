import { expect, test } from '@playwright/test';
import { createFromHome, frame, sendMessage, waitVersion } from './helpers';

/** GitHub issue #4：生成时代码面板实时跟随正在写入的文件（默认开启） */
test('#4 代码面板默认跟随：切到正在写入的文件、内容实时增长、完成后回到预览', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[slow] 做一个跟随测试应用');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  // 生成中：自动切到代码标签，跟随 App.jsx，内容逐步增长
  await expect(page.getByTestId('code-following')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('code-active')).toHaveText('App.jsx', { timeout: 20_000 });
  const content = page.getByTestId('code-content');
  const len1 = (await content.innerText()).length;
  await expect.poll(async () => (await content.innerText()).length, { timeout: 10_000 }).toBeGreaterThan(len1 + 100);
  await expect(page.getByTestId('code-following')).toContainText('正在跟随');
  // 自动滚到末尾
  const atBottom = await content.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  expect(atBottom).toBe(true);

  // 手动点别的文件：暂停跟随，可一键回到正在写入的文件
  await page.getByTestId('code-file').filter({ hasText: 'app.json' }).click();
  await expect(page.getByTestId('code-following')).toContainText('已暂停跟随');
  await page.getByRole('button', { name: '回到 App.jsx' }).click();
  await expect(page.getByTestId('code-following')).toContainText('正在跟随');

  // 完成后回到预览
  await waitVersion(page, 1);
  await expect(page.getByTestId('tab-preview')).toHaveClass(/font-medium/);
  await expect(frame(page).getByTestId('app-title')).toHaveText('跟随测试应用');
});

test('#4 关闭“跟随生成”后保持在预览，设置会被记住', async ({ page }) => {
  await createFromHome(page, '做一个不跟随的应用');
  await page.getByTestId('follow-toggle').uncheck();
  await sendMessage(page, '[slow] 主色改成绿色');
  await expect(page.getByTestId('preview-overlay')).toBeVisible();
  await expect(page.getByTestId('code-following')).toHaveCount(0);
  // 手动切到代码标签时仍然能看到实时内容
  await page.getByTestId('tab-code').click();
  await expect(page.getByTestId('code-following')).toBeVisible();
  await waitVersion(page, 2);
  await expect(page.getByTestId('tab-code')).toHaveClass(/font-medium/);
  await page.reload();
  await expect(page.getByTestId('follow-toggle')).not.toBeChecked();
});

/** GitHub issue #3：广场 / 首页 / 项目列表的缩略图是应用的真实预览，而不是首字 */
test('#3 缩略图显示已发布应用的真实渲染', async ({ page, browser }) => {
  await createFromHome(page, '做一个缩略图测试');
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-url')).toBeVisible();

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto('/discover');
  const card = v.getByTestId('published-card').filter({ hasText: '做一个缩略图测试' });
  await expect(card.frameLocator('[data-testid=thumb-frame]').getByTestId('app-title')).toHaveText('缩略图测试');
  // 缩略图只读：不可交互、不占用 Tab 焦点
  await expect(card.getByTestId('thumb-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(card.getByTestId('thumb-frame')).toHaveClass(/pointer-events-none/);
  await v.screenshot({ path: 'screens/20-discover-thumbnails.png' });

  await v.goto('/');
  const featured = v.getByTestId('featured').getByTestId('published-card').first();
  await expect(featured.frameLocator('[data-testid=thumb-frame]').getByTestId('app-title')).toHaveText('缩略图测试');
  await ctx.close();

  // 项目列表的卡片也显示当前版本的预览
  await page.goto('/projects');
  const mine = page.getByTestId('project-card').first();
  await expect(mine.frameLocator('[data-testid=thumb-frame]').getByTestId('app-title')).toHaveText('缩略图测试');
  await page.screenshot({ path: 'screens/21-project-thumbnails.png' });
});
