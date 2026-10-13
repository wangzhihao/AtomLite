import { expect, test } from '@playwright/test';
import { createFromHome, sendMessage } from './helpers';

/** 模型服务额度用完（402 billing_error）：告诉用户是我们没钱了，并给出联系作者充值的方式 */

test('新建时额度用完：显示中文提示和作者邮箱，不产生版本，刷新后仍在', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-prompt').fill('[quota] 做一个记账本');
  await page.getByTestId('home-submit').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const card = page.getByTestId('quota-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('模型服务额度已用完');
  await expect(card).toContainText('账户余额不足');
  await expect(card).toContainText('不是你的操作问题');
  const email = card.getByTestId('quota-email');
  await expect(email).toHaveText('accept.acm@gmail.com');
  await expect(email).toHaveAttribute('href', /^mailto:accept\.acm@gmail\.com/);
  await expect(page.getByTestId('version-badge')).toHaveText('未生成');
  await page.screenshot({ path: 'screens/40-quota.png' });
  await page.reload();
  await expect(page.getByTestId('quota-card')).toContainText('accept.acm@gmail.com');
});

test('修改时额度用完：分派阶段就停下并提示，已有版本不受影响', async ({ page }) => {
  await createFromHome(page, '做一个额度测试');
  await sendMessage(page, '[quota] 主色改成绿色');
  await expect(page.getByTestId('quota-card').last()).toContainText('accept.acm@gmail.com', { timeout: 20_000 });
  await expect(page.getByTestId('version-badge')).toHaveText('版本 1');
  // 只有分派这一次调用，没有继续叫 Kai
  await expect(page.getByTestId('msg-engineer')).toHaveCount(1);
});
