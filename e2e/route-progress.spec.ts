import { expect, test } from '@playwright/test';
import { createFromHome } from './helpers';

/** 发消息后马上有进度：分派（Leo 理解消息）本身也算一步，先于分派结果下发；大图在浏览器里先压缩再上传 */

test('分派前就开始 run 和进度：先只有“分派”一步，分派完成后给出完整步骤', async ({ page }) => {
  const id = await createFromHome(page, '做一个分派进度测试');
  const res = await page.request.post(`/api/projects/${id}/generate`, { data: { message: '主色改成绿色' } });
  const events = (await res.text())
    .split('\n\n')
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: /^data: (.*)$/m.exec(b)?.[1] }))
    .filter((e) => e.event);
  const names = events.map((e) => e.event);
  expect(names[0]).toBe('run_started');
  const firstSteps = events.find((e) => e.event === 'steps')!;
  expect(JSON.parse(firstSteps.data!).steps.map((s: { id: string }) => s.id)).toEqual(['route']);
  // “分派”这一步在任何角色开始工作之前就已下发
  expect(names.indexOf('steps')).toBeLessThan(names.indexOf('agent_started'));
  expect(events.some((e) => e.event === 'step' && JSON.parse(e.data!).id === 'route')).toBe(true);
  const allSteps = events.filter((e) => e.event === 'steps').map((e) => JSON.parse(e.data!).steps.map((s: { id: string }) => s.id));
  expect(allSteps.at(-1)).toEqual(['route', 'code', 'check', 'save', 'suggest']);
});

test('大图先在浏览器里压缩到长边 1568 以内再上传，芯片显示上传后的大小', async ({ page }) => {
  await createFromHome(page, '做一个压缩测试');
  // 在浏览器里画一张 3000×2000 的 PNG
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${i * 7}, 70%, 50%)`;
      ctx.fillRect((i * 97) % 3000, (i * 53) % 2000, 120, 120);
    }
    return c.toDataURL('image/png').split(',')[1];
  });
  const original = Buffer.from(b64, 'base64');
  await page.getByTestId('attach-input').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: original });
  const chip = page.getByTestId('attach-chip');
  await expect(chip).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(chip.getByTestId('attach-chip-status')).toContainText(/已上传 · \d+ (KB|MB)/);

  // 发送后看服务器上存的那张图
  await page.getByTestId('chat-input').fill('参考这张图');
  await page.getByTestId('send').click();
  const img = page.getByTestId('message-attachments').last().locator('img');
  await expect(img).toHaveAttribute('alt', 'big.webp');
  const dims = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(Math.max(...dims)).toBeLessThanOrEqual(1568);
  expect(dims[0] / dims[1]).toBeCloseTo(1.5, 1);
  const stored = await page.request.get((await img.getAttribute('src'))!);
  expect(stored.headers()['content-type']).toBe('image/webp');
  expect((await stored.body()).length).toBeLessThan(original.length);
});
