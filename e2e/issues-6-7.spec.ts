import { expect, test } from '@playwright/test';
import { createFromHome, sendMessage, waitVersion } from './helpers';

/** GitHub issue #7：直接和某个成员对话会有回应，而不是被当成修改请求 */
test('#7 点名和 Kai 对话：Kai 直接回复，不改应用、不生成新版本', async ({ page }) => {
  await createFromHome(page, '做一个对话测试');
  await sendMessage(page, 'hi, kai你还能对话么');
  const kai = page.getByTestId('msg-engineer').last();
  await expect(kai).toContainText('我在，可以直接对话', { timeout: 20_000 });
  await expect(page.getByTestId('live-run')).toHaveCount(0);
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  await expect(page.getByTestId('system-message')).toHaveCount(0);
  // 没点名时由 Leo 回答
  await sendMessage(page, '你们支持 3D 吗？');
  await expect(page.getByTestId('leader-message').last()).toContainText('我在，可以直接对话', { timeout: 20_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  // 之后正常提修改要求仍然走修改路径
  await sendMessage(page, '主色改成绿色');
  await waitVersion(page, 2);
});

/** GitHub issue #6：输出被长度上限截断时如实告诉用户，而不是“没有输出任何文件” */
test('#6 输出超出长度上限：提示被截断以及怎么办，版本保持不变', async ({ page }) => {
  await createFromHome(page, '做一个截断测试');
  await sendMessage(page, '[truncate] 改成可交互的 3D 模型');
  const err = page.getByTestId('system-message').last();
  await expect(err).toContainText('超出了单次长度上限', { timeout: 20_000 });
  await expect(err).toContainText('拆成几步');
  await expect(err).not.toContainText('没有输出任何文件');
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
});

test('#6 Kai 用文字回答而没有写文件：作为正常回复保存，不报错', async ({ page }) => {
  await createFromHome(page, '做一个文字回复测试');
  await sendMessage(page, '[textonly] 改成可交互的 3D 模型');
  await expect(page.getByTestId('msg-engineer').last()).toContainText('想先确认', { timeout: 20_000 });
  await expect(page.getByTestId('system-message')).toHaveCount(0);
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  await page.reload();
  await expect(page.getByTestId('msg-engineer').last()).toContainText('想先确认');
});

test('#6 three.js 已自托管，可按需加载', async ({ request }) => {
  const res = await request.get('/vendor/three.js');
  expect(res.status()).toBe(200);
  expect((await res.body()).length).toBeGreaterThan(500_000);
});
