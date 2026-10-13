import { getUser, signInGuest } from '@/lib/server/auth';
import { handleError, json } from '@/lib/server/http';

export async function POST() {
  try {
    const existing = await getUser();
    return json({ user: existing ?? (await signInGuest()) });
  } catch (err) {
    return handleError(err);
  }
}
