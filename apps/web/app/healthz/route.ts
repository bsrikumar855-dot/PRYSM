export const dynamic = 'force-dynamic';

/** Liveness: the Next.js server is up. */
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
