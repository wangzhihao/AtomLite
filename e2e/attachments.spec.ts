import { expect, test, type Page } from '@playwright/test';
import { createFromHome, frame, sendMessage, waitVersion } from './helpers';

/** 附件：上传图片 / PDF / 文本给团队看；图片还能直接用在生成的应用里 */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId('attach-input').setInputFiles(files);
}

test('在工作区附上图片：Kai 看到附件，消息里显示缩略图，图片直接用进应用，刷新后仍在', async ({ page }) => {
  await createFromHome(page, '做一个个人主页');
  await attach(page, [png('avatar.png')]);
  await expect(page.getByTestId('attach-chip')).toHaveAttribute('data-status', 'done');
  await sendMessage(page, '把这张图做成头像');
  await waitVersion(page, 2);
  await expect(page.getByTestId('attach-tray')).toHaveCount(0);
  await expect(page.getByTestId('user-message').last()).toHaveText('把这张图做成头像');
  const thumb = page.getByTestId('message-attachments').last().locator('img');
  await expect(thumb).toHaveAttribute('alt', 'avatar.png');
  await expect(page.getByTestId('msg-engineer').last()).toContainText('我看到了你上传的附件：avatar.png');
  // 图片在沙箱 iframe 里也能加载
  const img = frame(page).getByTestId('app-image');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  await page.screenshot({ path: 'screens/50-attachment.png' });

  // 附件地址：正确的类型、nosniff、可长期缓存
  const url = await thumb.getAttribute('src');
  const res = await page.request.get(url!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['cache-control']).toContain('immutable');

  await page.reload();
  await expect(page.getByTestId('message-attachments').last().locator('img')).toHaveAttribute('alt', 'avatar.png');
});

test('首页附上文本文件直接开始：需求和附件一起交给团队', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('attach-input').setInputFiles({ name: 'bill.csv', mimeType: 'text/csv', buffer: Buffer.from('项目,金额\n午饭,25\n地铁,4') });
  await expect(page.getByTestId('attach-chip')).toHaveAttribute('data-status', 'done');
  await page.getByTestId('home-prompt').fill('按这个表格做一个记账本');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('version-tag').first()).toHaveText('版本 1', { timeout: 30_000 });
  await expect(page.getByTestId('message-attachments').first()).toContainText('bill.csv');
  await expect(page.getByTestId('msg-engineer')).toContainText('bill.csv');
});

test('对话时也能发图：被点名的成员看到附件', async ({ page }) => {
  await createFromHome(page, '做一个对话附件测试');
  await attach(page, [png('mockup.png')]);
  await expect(page.getByTestId('attach-chip')).toHaveAttribute('data-status', 'done');
  await sendMessage(page, 'kai 你看看这张图？');
  await expect(page.getByTestId('msg-engineer').last()).toContainText('我看到了你发的 mockup.png', { timeout: 20_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
});

test('拒绝不支持或过大的文件，每条消息最多 4 个附件', async ({ page }) => {
  await createFromHome(page, '做一个附件校验测试');
  await attach(page, [{ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]);
  await expect(page.getByTestId('attach-chip').last()).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('attach-chip').last()).toHaveAttribute('title', /只支持/);
  await page.getByRole('button', { name: '移除 evil.svg' }).click();

  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  await attach(page, [{ name: 'huge.png', mimeType: 'image/png', buffer: big }]);
  await expect(page.getByTestId('attach-chip').last()).toHaveAttribute('title', /文件太大/);
  await page.getByRole('button', { name: '移除 huge.png' }).click();

  await attach(page, [png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')]);
  await expect(page.locator('[data-testid=attach-chip][data-status=done]')).toHaveCount(4);
  await expect(page.locator('[data-testid=attach-chip][data-status=error]')).toHaveAttribute('title', /最多 4 个/);
});

test('不能引用别人上传的附件', async ({ page, browser }) => {
  await createFromHome(page, '做一个附件归属测试');
  await attach(page, [png('mine.png')]);
  await expect(page.getByTestId('attach-chip')).toHaveAttribute('data-status', 'done');
  const res = await page.request.post('/api/uploads', { multipart: { file: { name: 'mine2.png', mimeType: 'image/png', buffer: PNG } } });
  const foreignId = (await res.json()).attachment.id as string;

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.goto('/login');
  await other.getByTestId('guest').click();
  await other.waitForURL('**/projects');
  const { project } = await (await other.request.post('/api/projects', { data: { name: '别人的项目', prompt: '做一个应用', attachments: [foreignId] } })).json();
  const detail = await (await other.request.get(`/api/projects/${project.id}`)).json();
  expect(detail.messages[0].meta.attachments).toBeUndefined();
  await ctx.close();
});
