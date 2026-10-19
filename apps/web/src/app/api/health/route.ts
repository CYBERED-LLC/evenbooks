import { getReadyDb } from '@/server/db';
import { json } from '@/server/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getReadyDb();
    return json({ ok: true, db: 'up' });
  } catch (err) {
    return json({ ok: false, db: 'down', error: (err as Error).message }, { status: 503 });
  }
}
