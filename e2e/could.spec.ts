import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createFromHome, frame, waitVersion } from './helpers';

/** 设计文档第 2 节 Could 能力：Discover 广场 + Remix、代码查看与 zip 下载、/stats 指标页 */

test('Discover 广场与首页精选：发布后出现，可从卡片 Remix', async ({ page, browser }) => {
  await createFromHome(page, '做一个广场展示应用');
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-url')).toBeVisible();

  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto('/');
  await expect(visitor.getByTestId('featured').getByTestId('published-name').first()).toHaveText('广场展示应用');
  await visitor.getByTestId('nav-discover').click();
  await visitor.waitForURL('**/discover');
  const card = visitor.getByTestId('published-card').filter({ hasText: '广场展示应用' });
  await expect(card).toHaveCount(1);
  await card.getByTestId('published-remix').click();
  await visitor.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(visitor.getByTestId('project-title')).toContainText('Remix');
  await expect(frame(visitor).getByTestId('app-title')).toHaveText('广场展示应用');
  await ctx.close();
});

test('代码查看与 zip 下载：包含源文件、可直接打开的 index.html 和说明', async ({ page }) => {
  await createFromHome(page, '做一个下载测试');
  await page.getByTestId('tab-code').click();
  await expect(page.getByTestId('code-view')).toContainText('ReactDOM.createRoot');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-zip').click()]);
  expect(download.suggestedFilename()).toBe('做一个下载测试-v1.zip');
  const buf = readFileSync((await download.path())!);
  expect(buf.subarray(0, 2).toString()).toBe('PK');
  const text = buf.toString('utf8');
  for (const name of ['src/App.jsx', 'src/design.json', 'index.html', 'README.md']) expect(text).toContain(name);
});

test('/stats 指标页：统计首次通过、自动修复与错误类型', async ({ page }) => {
  await createFromHome(page, '做一个指标测试');
  // 等运行检查回写（渲染后 3 秒窗口）
  await expect.poll(async () => (await (await page.request.get('/api/stats')).json()).metrics.overall.runs, { timeout: 15_000 }).toBe(1);

  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[broken] 做一个需要自愈的应用');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await waitVersion(page, 2);
  // v1 运行出错后 run 先记为未通过，自动修复的 v2 运行检查通过后才记为最终可用
  await expect.poll(async () => (await (await page.request.get('/api/stats')).json()).metrics.overall.finalOkRate, { timeout: 15_000 }).toBe(1);

  await page.getByTestId('nav-stats').click();
  await page.waitForURL('**/stats');
  await expect(page.getByTestId('stat-firstPassRate')).toContainText('50%');
  await expect(page.getByTestId('stat-fixSuccessRate')).toContainText('100%');
  await expect(page.getByTestId('stat-finalOkRate')).toContainText('100%');
  await expect(page.getByTestId('kind-runtime')).toContainText('运行时异常');
  await expect(page.getByTestId('intent-create')).toContainText('2');
});

test('团队配置面板：关掉 Nora / Mia / Sage 后新建只有 Kai，设置在本浏览器保留', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('做一个团队配置测试');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await waitVersion(page, 1);
  await page.getByTestId('team').click();
  await expect(page.getByTestId('team-panel')).toBeVisible();
  for (const id of ['planner', 'designer', 'advisor']) await page.getByTestId(`toggle-${id}`).click();
  await expect(page.getByTestId('toggle-planner')).toHaveAttribute('aria-checked', 'false');

  await page.goto('/');
  await page.getByTestId('home-prompt').fill('做一个精简团队应用');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await waitVersion(page, 1);
  await expect(page.getByTestId('msg-engineer')).toHaveCount(1);
  await expect(page.getByTestId('msg-planner')).toHaveCount(0);
  await expect(page.getByTestId('msg-designer')).toHaveCount(0);
  await expect(page.getByTestId('msg-advisor')).toHaveCount(0);
  await expect(page.getByTestId('leader-message').first()).toContainText('Kai 开工');
  await page.getByTestId('team').click();
  await expect(page.getByTestId('toggle-designer')).toHaveAttribute('aria-checked', 'false');
});

test('验收 QA：Quinn 按功能点做交互测试，在独立沙箱里执行，不影响用户数据', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('做一个验收测试');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByTestId('team').click();
  await page.getByTestId('toggle-qa').click();
  await page.getByTestId('team').click();
  await waitVersion(page, 1);
  // 第一个版本生成时 QA 还没打开，用一轮修改触发验收
  await page.getByTestId('chat-input').fill('加一个按月筛选');
  await page.getByTestId('send').click();
  await waitVersion(page, 2);
  const quinn = page.getByTestId('msg-qa');
  await expect(quinn).toHaveCount(1, { timeout: 20_000 });
  await expect(quinn).toContainText('3 个功能点测了 3 个，全部通过');
  await expect(quinn.getByTestId('qa-result')).toHaveCount(3);
  // 验收在独立 iframe 中执行：用户预览里没有测试数据
  await expect(frame(page).getByTestId('items')).toContainText('还没有内容');
  await expect(frame(page).getByTestId('items')).not.toContainText('QA 测试条目');
});

test('验收 QA 发现功能缺陷 → Max 自动修复 → 再次验收通过', async ({ page }) => {
  await page.goto('/projects');
  await page.goto('/login');
  await page.getByTestId('guest').click();
  await page.waitForURL('**/projects');
  await page.evaluate(() => localStorage.setItem('atoms:team', JSON.stringify({ qa: true })));
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[qafail] 做一个有缺陷的应用');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const quinn = page.getByTestId('msg-qa');
  await expect(quinn).toHaveCount(2, { timeout: 40_000 });
  await expect(quinn.first()).toContainText('没有通过');
  await expect(quinn.first()).toContainText('添加条目');
  await expect(page.getByTestId('msg-fixer')).toContainText('判断条件写反');
  await expect(quinn.last()).toContainText('全部通过');
  await expect(page.getByTestId('version-badge')).toHaveText('版本 2');
  await expect(page.getByTestId('usage-tag').last()).toContainText('自动修复 1 次');
  await page.goto('/stats');
  await expect(page.getByTestId('kind-qa')).toContainText('验收未通过');
});
