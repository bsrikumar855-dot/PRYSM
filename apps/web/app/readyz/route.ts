import { checkReadiness } from '../../lib/readiness';

export const dynamic = 'force-dynamic';

/** Readiness: the console is useless without the API, so it's ready only when the API is live. */
export async function GET(): Promise<Response> {
  const result = await checkReadiness(process.env['API_URL'] ?? 'http://127.0.0.1:4000');
  return Response.json(result, { status: result.status === 'ready' ? 200 : 503 });
}
