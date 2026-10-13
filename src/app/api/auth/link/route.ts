import { linkEmail } from '@/lib/server/auth';
import { handleError, json, readJson } from '@/lib/server/http';

export async function POST(req: Request) {
  try {
    const body = await readJson<{ email: string; password: string }>(req);
    return json({ user: await linkEmail(String(body.email ?? ''), String(body.password ?? '')) });
  } catch (err) {
    return handleError(err);
  }
}
