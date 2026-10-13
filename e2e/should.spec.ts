import { expect, test } from '@playwright/test';
import { createFromHome, frame, rgb, sendMessage, shot, waitVersion } from './helpers';

/**
 * 设计文档第 2 节 Should 能力的端到端验收：
 *  多 Agent 流水线、角色注册表 + 设计师、建议者、需求澄清、服务端检查 + 修复回路、
 *  运行时错误自愈、质量与成本度量、版本回滚、一键发布与 Remix
 */

test('多 Agent 流水线：Leo 播报 → Nora 规划卡片 → Mia 设计规范 → Kai 编码 → Sage 建议，刷新后完整保留', async ({ page }) => {
  await createFromHome(page, '做一个记账本');
  await expect(page.getByTestId('msg-planner').getByTestId('plan-card')).toContainText('添加条目');
  await expect(page.getByTestId('msg-designer').getByTestId('design-card')).toContainText('primary');
  await expect(page.getByTestId('msg-engineer')).toContainText('记账本');
  await expect(page.getByTestId('msg-advisor').getByTestId('suggestion-chip')).toHaveCount(3);
  await expect(page.getByTestId('leader-message').first()).toContainText('Nora 先梳理需求');
  // Mia 的设计规范生效（主色来自 design.json 的 CSS 变量），且不会破坏 Tailwind 的间距体系（px-3 = 12px）
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.indigo);
  await expect(frame(page).getByTestId('item-input')).toHaveCSS('padding-left', '12px');
  await shot(page, '10-pipeline');

  await page.reload();
  await expect(page.getByTestId('msg-planner').getByTestId('plan-card')).toBeVisible();
  await expect(page.getByTestId('msg-designer').getByTestId('design-card')).toBeVisible();
  await expect(page.getByTestId('msg-advisor').getByTestId('suggestion-chip')).toHaveCount(3);

  // 修改路径跳过 Planner / Designer
  await sendMessage(page, '加一个按月筛选');
  await waitVersion(page, 2);
  await expect(page.getByTestId('msg-planner')).toHaveCount(1);
  await expect(page.getByTestId('msg-designer')).toHaveCount(1);
  await expect(page.getByTestId('msg-engineer')).toHaveCount(2);
});

test('建议者：点击建议 chip 直接作为下一条消息发送', async ({ page }) => {
  await createFromHome(page, '做一个读书笔记');
  const chips = page.getByTestId('msg-advisor').last().getByTestId('suggestion-chip');
  await expect(chips).toHaveCount(3);
  await chips.filter({ hasText: '主色改成绿色' }).click();
  await waitVersion(page, 2);
  await expect(page.getByTestId('user-message').last()).toHaveText('主色改成绿色');
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.green);
  // 旧的建议不再可点
  await expect(page.getByTestId('msg-advisor').first().getByTestId('suggestion-chip').first()).toBeDisabled();
});

test('需求澄清：个人博客先问问题，回答后生成，且不再重复提问', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('帮我做一个漂亮的个人定制化博客网站并且发布');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const card = page.getByTestId('clarify-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('未生成');
  await expect(card.getByTestId('clarify-input')).toHaveCount(3);
  await shot(page, '11-clarify');

  // 刷新后卡片仍可填写
  await page.reload();
  await page.getByTestId('clarify-input').nth(0).fill('小王');
  await page.getByTestId('clarify-input').nth(1).fill('量化交易、分布式系统');
  await page.getByTestId('clarify-submit').click();
  await waitVersion(page, 1);
  await expect(page.getByTestId('user-message').last()).toContainText('小王');
  await expect(page.getByTestId('clarify-card')).toHaveCount(1);
  await expect(page.getByTestId('msg-planner').last().getByTestId('plan-card')).toBeVisible();
  await expect(frame(page).getByTestId('app-title')).toContainText('个人定制化博客');
});

test('需求澄清：可以跳过，用默认值直接开始', async ({ page }) => {
  await createFromHomeNoWait(page, '[clarify] 做一个作品集');
  await page.getByTestId('clarify-skip').click();
  await waitVersion(page, 1);
  await expect(page.getByTestId('user-message').last()).toContainText('先帮我随便做');
  await expect(page.getByTestId('msg-planner').last().getByTestId('plan-card')).toContainText('假设');
});

test('服务端语法检查失败 → Max 自动修复 → 通过后才保存版本', async ({ page }) => {
  await createFromHome(page, '[syntax] 做一个语法测试');
  await expect(page.getByTestId('msg-fixer')).toBeVisible();
  await expect(page.getByTestId('msg-fixer')).toContainText('语法错误');
  await expect(page.getByTestId('usage-tag').last()).toContainText('自动修复 1 次');
  await expect(frame(page).getByTestId('app-title')).toBeVisible();
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('version-item')).toHaveCount(1); // 语法错误的中间结果不落库
});

test('服务端检查：同一错误重复即停止，不产生版本', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[syntax][stubborn] 做一个修不好的应用');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('system-message').last()).toContainText('自动修复后仍未通过语法检查', { timeout: 30_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('未生成');
  await expect(page.getByTestId('msg-fixer')).toHaveCount(1);
});

test('运行时错误自愈：预览报错后自动修复，生成“自动修复”版本', async ({ page }) => {
  await createFromHome(page, '[broken] 做一个会自愈的应用');
  await waitVersion(page, 2);
  await expect(frame(page).getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('msg-fixer')).toBeVisible();
  await expect(page.getByTestId('error-bar')).toHaveCount(0);
  await expect(page.getByTestId('usage-tag').last()).toContainText('自动修复 1 次');
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('version-item').first()).toContainText('自动修复');
  await expect(page.getByTestId('version-item').last()).toContainText('运行出错');
  await shot(page, '12-autofix');
});

test('版本回滚：复制目标版本生成新版本，历史保留', async ({ page }) => {
  await createFromHome(page, '做一个回滚测试');
  await sendMessage(page, '主色改成绿色');
  await waitVersion(page, 2);
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.green);
  await page.getByTestId('tab-versions').click();
  await page.getByTestId('version-item').last().getByTestId('restore').click();
  await expect(page.getByTestId('version-badge')).toHaveText('版本 3');
  await expect(page.getByTestId('version-item')).toHaveCount(3);
  await expect(page.getByTestId('version-item').first()).toContainText('回滚到版本 1');
  await expect(page.getByTestId('system-message').last()).toContainText('已回滚到版本 1');
  await page.getByTestId('tab-preview').click();
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.indigo);
  // 回滚后继续修改，基于回滚后的文件
  await sendMessage(page, '主色改成红色');
  await waitVersion(page, 4);
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.red);
});

test('一键发布：公开链接在无痕会话可访问，发布后修改不影响已发布内容，再次发布才更新；可 Remix', async ({ page, browser }) => {
  await createFromHome(page, '做一个发布测试');
  await page.getByTestId('publish').click();
  const url = await page.getByTestId('publish-url').inputValue();
  expect(url).toMatch(/\/s\/[a-z0-9]{6,8}$/);
  await expect(page.getByTestId('publish')).toHaveText('已发布');
  await shot(page, '13-published-popover');

  const visitor = await browser.newContext();
  const v = await visitor.newPage();
  await v.goto(url);
  await expect(frame(v).getByTestId('app-title')).toHaveText('发布测试');
  await expect(frame(v).getByTestId('app-title')).toHaveCSS('color', rgb.indigo);
  await expect(v.getByTestId('built-with')).toBeVisible();
  expect(await v.title()).toContain('发布测试');
  await shot(v, '14-published-page');

  // 发布后继续修改：发布页不变
  await page.keyboard.press('Escape');
  await sendMessage(page, '主色改成绿色');
  await waitVersion(page, 2);
  await expect(page.getByTestId('publish')).toHaveText('更新发布');
  await v.reload();
  await expect(frame(v).getByTestId('app-title')).toHaveCSS('color', rgb.indigo);
  // 再次发布：同一链接更新
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-url')).toHaveValue(url);
  await v.reload();
  await expect(frame(v).getByTestId('app-title')).toHaveCSS('color', rgb.green);

  // 访客 Remix：自动以游客身份获得一份可继续编辑的副本
  await v.getByTestId('remix').click();
  await v.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(v.getByTestId('project-title')).toContainText('Remix');
  await expect(v.getByTestId('version-badge')).toHaveText('版本 1');
  await expect(frame(v).getByTestId('app-title')).toHaveCSS('color', rgb.green);
  await sendMessage(v, '主色改成红色');
  await waitVersion(v, 2);
  await expect(frame(v).getByTestId('app-title')).toHaveCSS('color', rgb.red);
  // 原作者的项目不受影响
  await page.reload();
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.green);
  await visitor.close();

  // 不存在的链接返回 404 页面
  const missing = await page.request.get('/s/nonexist');
  expect(missing.status()).toBe(404);
});

async function createFromHomeNoWait(page: import('@playwright/test').Page, prompt: string) {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill(prompt);
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('clarify-card')).toBeVisible({ timeout: 20_000 });
}
