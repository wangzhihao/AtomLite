import { getUser } from '@/lib/server/auth';
import { json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  return json({ user: await getUser() });
}
