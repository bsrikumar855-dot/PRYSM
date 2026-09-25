export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: { name: string; ok: boolean }[];
}

/** Checks the API's liveness endpoint with a short timeout. */
export async function checkReadiness(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Readiness> {
  const ok = await fetchImpl(new URL('/healthz', apiUrl), { signal: AbortSignal.timeout(2_000), cache: 'no-store' }).then(
    (res) => res.ok,
    () => false,
  );
  return { status: ok ? 'ready' : 'not_ready', checks: [{ name: 'api', ok }] };
}
