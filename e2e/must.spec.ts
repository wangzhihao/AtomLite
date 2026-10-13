import { expect, test } from '@playwright/test';
import { createFromHome, frame, rgb, sendMessage, shot, waitVersion } from './helpers';

/**
 * 设计文档第 2 节的 6 项 Must 能力的端到端验收：
 *  1 账号体系：邮箱登录 + 游客模式      2 项目管理：创建、列表、重命名、删除
 *  3 对话驱动生成 + 流式输出            4 沙箱实时预览（桌面 / 手机宽度）
 *  5 持久化：对话、代码、版本            6 多轮迭代修改
 */

test('[1][3][4][5] 游客一句话生成：流式输出 → 沙箱预览可交互 → 刷新后完整保留', async ({ page }) => {
  await page.goto('/');
  await shot(page, '01-home');
  await page.getByTestId('home-prompt').fill('做一个读书清单');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  // 流式过程：Agent 时间线和文件进度项出现
  await expect(page.getByTestId('live-run')).toBeVisible();
  await expect(page.getByTestId('file-progress').filter({ hasText: 'App.jsx' }).first()).toBeVisible({ timeout: 30_000 });
  await waitVersion(page, 1);
  await expect(page.getByTestId('user-badge')).toContainText('游客');

  // 首页输入的需求不会丢失
  await expect(page.getByTestId('user-message').first()).toHaveText('做一个读书清单');
  await expect(page.getByTestId('msg-engineer').getByTestId('agent-message')).toContainText('读书清单');
  await expect(page.getByTestId('usage-tag').first()).toContainText('tokens');

  // 沙箱预览：应用可以交互，localStorage 走存储垫片
  const app = frame(page);
  await expect(app.getByTestId('app-title')).toHaveText('读书清单');
  await app.getByTestId('item-input').fill('三体');
  await app.getByTestId('add-btn').click();
  await expect(app.getByTestId('items')).toContainText('三体');
  await shot(page, '02-workspace-v1');

  // 刷新后：对话、版本、代码、应用数据都在
  await page.reload();
  await expect(page.getByTestId('user-message').first()).toHaveText('做一个读书清单');
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  await expect(frame(page).getByTestId('app-title')).toHaveText('读书清单');
  await expect(frame(page).getByTestId('items')).toContainText('三体');
  await page.getByTestId('tab-code').click();
  await expect(page.getByTestId('code-view')).toContainText('ReactDOM.createRoot');
});

test('[4] 预览沙箱隔离：iframe 不带 allow-same-origin', async ({ page }) => {
  await createFromHome(page, '做一个隔离测试应用');
  const sandbox = await page.getByTestId('preview-frame').getAttribute('sandbox');
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  // 生成的代码读不到父页面的 cookie / 存储
  const result = await page.getByTestId('preview-frame').evaluate((el: HTMLIFrameElement) => {
    try {
      return String(el.contentDocument?.cookie ?? 'no-access');
    } catch {
      return 'no-access';
    }
  });
  expect(result).toBe('no-access');
});

test('[6][5] 多轮迭代：每轮生成新版本，只改变更文件，预览同步，历史版本可查看', async ({ page }) => {
  await createFromHome(page, '做一个团队周报');
  const title = frame(page).getByTestId('app-title');
  await expect(title).toHaveCSS('color', rgb.indigo);

  await sendMessage(page, '主色改成绿色');
  await expect(page.getByTestId('live-run')).toBeVisible();
  await waitVersion(page, 2);
  await expect(title).toHaveCSS('color', rgb.green);
  await expect(frame(page).getByTestId('changes')).toContainText('主色改成绿色');

  await sendMessage(page, '加一个导出 CSV 按钮');
  await waitVersion(page, 3);
  // 未变更的 design.json 被保留：仍是绿色；修改记录累积
  await expect(title).toHaveCSS('color', rgb.green);
  await expect(frame(page).getByTestId('changes').locator('li')).toHaveCount(2);
  await shot(page, '03-iteration-v3');

  // 第三轮只输出了 changes.json
  await expect(page.getByTestId('msg-engineer').last().getByTestId('file-progress')).toHaveCount(1);

  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('version-item')).toHaveCount(3);
  await shot(page, '04-versions');
  await page.getByTestId('version-item').last().getByRole('button', { name: '预览' }).click();
  await expect(page.getByTestId('viewing-banner')).toContainText('版本 1');
  await expect(title).toHaveCSS('color', rgb.indigo);
  await page.getByRole('button', { name: '回到最新版本' }).click();
  await expect(title).toHaveCSS('color', rgb.green);

  await page.reload();
  await expect(page.getByTestId('user-message')).toHaveCount(3);
  await expect(page.getByTestId('version-tag')).toHaveCount(3);
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.green);
});

test('[3] 生成中可以停止：不产生新版本，上一版本保持可用', async ({ page }) => {
  await createFromHome(page, '做一个停止测试应用');
  await sendMessage(page, '[slow] 主色改成红色');
  await expect(page.getByTestId('stop')).toBeVisible();
  await expect(page.getByTestId('preview-overlay')).toBeVisible();
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('system-message').last()).toContainText('已停止生成', { timeout: 15_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.indigo);
  await shot(page, '05-stopped');

  // 停止后可以继续下一轮
  await sendMessage(page, '主色改成红色');
  await waitVersion(page, 2);
  await expect(frame(page).getByTestId('app-title')).toHaveCSS('color', rgb.red);
});

test('[4] 桌面 / 手机宽度切换', async ({ page }) => {
  await createFromHome(page, '做一个响应式应用');
  const iframe = page.getByTestId('preview-frame');
  expect((await iframe.boundingBox())!.width).toBeGreaterThan(800);
  await page.getByTestId('device-mobile').click();
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.width)).toBe(375);
  await expect(frame(page).getByTestId('app-title')).toBeVisible();
  await shot(page, '06-mobile');
  await page.getByTestId('device-desktop').click();
  await expect.poll(async () => (await iframe.boundingBox())!.width).toBeGreaterThan(800);
});

test('[4] 运行时报错修不好时出现错误条，“让 Agent 修复”发起新一轮', async ({ page }) => {
  // [stubborn]：Mock Fixer 修不好，自动修复一次后同一错误签名重复，停止自动修复并交给用户
  await createFromHome(page, '[broken][stubborn] 做一个会出错的应用');
  await expect(page.getByTestId('error-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('版本 2');
  await shot(page, '07-error-bar');
  await page.getByTestId('fix').click();
  await expect(page.getByTestId('user-message').last()).toContainText('让 Agent 修复');
  await waitVersion(page, 3);
});

test('[2] 项目管理：创建、列表、重命名、删除', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('guest').click();
  await page.waitForURL('**/projects');
  await expect(page.getByTestId('empty-projects')).toBeVisible();

  await page.getByTestId('new-project').click();
  await page.getByTestId('new-project-name').fill('测试项目A');
  await page.getByTestId('new-project-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('project-title')).toHaveText('测试项目A');

  // 工作区顶栏也可以重命名
  await page.getByTestId('project-title').click();
  await page.getByTestId('project-title-input').fill('测试项目B');
  await page.getByTestId('project-title-input').press('Enter');
  await expect(page.getByTestId('project-title')).toHaveText('测试项目B');

  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await expect(page.getByTestId('project-name')).toHaveText('测试项目B');

  await page.getByTestId('rename').click();
  await page.getByTestId('rename-input').fill('改名后的项目');
  await page.getByTestId('rename-input').press('Enter');
  await expect(page.getByTestId('project-name')).toHaveText('改名后的项目');
  await page.reload();
  await expect(page.getByTestId('project-name')).toHaveText('改名后的项目');
  await shot(page, '08-projects');

  await page.getByTestId('delete').click();
  await page.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('empty-projects')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('empty-projects')).toBeVisible();
});

test('[1][5] 邮箱注册 / 登录 / 退出，数据按用户隔离', async ({ page }) => {
  const a = `a${Date.now()}@example.com`;
  const b = `b${Date.now()}@example.com`;

  await page.goto('/login');
  await page.getByTestId('tab-signup').click();
  await page.getByTestId('email').fill(a);
  await page.getByTestId('password').fill('secret123');
  await page.getByTestId('auth-submit').click();
  await page.waitForURL('**/projects');
  await expect(page.getByTestId('user-badge')).toHaveText(a);
  const created = await page.request.post('/api/projects', { data: { name: 'A 的项目' } });
  expect(created.status()).toBe(201);
  const projectA = (await created.json()).project.id as string;

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('nav-login')).toBeVisible();
  expect((await page.request.get('/api/projects')).status()).toBe(401);

  await page.goto('/login');
  await page.getByTestId('tab-signup').click();
  await page.getByTestId('email').fill(b);
  await page.getByTestId('password').fill('secret456');
  await page.getByTestId('auth-submit').click();
  await page.waitForURL('**/projects');
  await expect(page.getByTestId('empty-projects')).toBeVisible();
  // B 不能读、改、删、生成 A 的项目
  expect((await page.request.get(`/api/projects/${projectA}`)).status()).toBe(404);
  expect((await page.request.patch(`/api/projects/${projectA}`, { data: { name: 'x' } })).status()).toBe(404);
  expect((await page.request.delete(`/api/projects/${projectA}`)).status()).toBe(404);
  expect((await page.request.post(`/api/projects/${projectA}/generate`, { data: { message: 'hi' } })).status()).toBe(404);
  await page.goto(`/projects/${projectA}`);
  await expect(page.getByTestId('load-error')).toContainText('项目不存在');

  await page.getByTestId('logout').click();
  await page.goto('/login');
  await page.getByTestId('email').fill(a);
  await page.getByTestId('password').fill('wrong-password');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toHaveText('邮箱或密码错误');
  await page.getByTestId('password').fill('secret123');
  await page.getByTestId('auth-submit').click();
  await page.waitForURL('**/projects');
  await expect(page.getByTestId('project-name')).toHaveText('A 的项目');

  // 重复注册给出可读提示
  await page.getByTestId('logout').click();
  await page.goto('/login');
  await page.getByTestId('tab-signup').click();
  await page.getByTestId('email').fill(a);
  await page.getByTestId('password').fill('secret123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('已注册');
});

test('[1][5] 游客绑定邮箱后项目保留，可在新会话登录找回', async ({ page, browser }) => {
  const id = await createFromHome(page, '做一个绑定测试应用');
  const email = `g${Date.now()}@example.com`;
  await page.getByTestId('user-badge').click();
  await page.waitForURL('**/login?bind=1');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('secret123');
  await page.getByTestId('auth-submit').click();
  await page.waitForURL('**/projects');
  await expect(page.getByTestId('user-badge')).toHaveText(email);
  await expect(page.getByTestId('project-card')).toHaveCount(1);

  // 另一个全新的浏览器会话（相当于换设备）登录后能看到同一个项目和版本
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.goto('/login');
  await other.getByTestId('email').fill(email);
  await other.getByTestId('password').fill('secret123');
  await other.getByTestId('auth-submit').click();
  await other.waitForURL('**/projects');
  await other.goto(`/projects/${id}`);
  await expect(other.getByTestId('version-badge')).toHaveText('版本 1');
  await expect(frame(other).getByTestId('app-title')).toHaveText('绑定测试应用');
  await ctx.close();
});

test('API 输入校验与未登录保护', async ({ page, request }) => {
  expect((await request.get('/api/projects')).status()).toBe(401);
  expect((await request.post('/api/projects', { data: { name: 'x' } })).status()).toBe(401);

  await page.goto('/login');
  await page.getByTestId('guest').click();
  await page.waitForURL('**/projects');
  const { project } = await (await page.request.post('/api/projects', { data: { name: '校验' } })).json();
  const tooLong = await page.request.post(`/api/projects/${project.id}/generate`, { data: { message: '长'.repeat(4001) } });
  expect(tooLong.status()).toBe(400);
  expect((await tooLong.json()).error.message).toContain('4000');
  const empty = await page.request.post(`/api/projects/${project.id}/generate`, { data: { message: '   ' } });
  expect(empty.status()).toBe(400);
});
