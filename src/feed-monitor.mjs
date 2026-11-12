import { checkTelegramChannels } from './telegram-client.mjs';

/**
 * The summary of a check that FAILED (M-01).
 * A failed check is never a silent green and never an idle cycle: it is a
 * failed cycle — `failed=1, published=0` makes `failed > published` hold,
 * so the runner's threshold logic turns the window red and the failure
 * streak grows. Only a typed fatal is different: it aborts the window.
 */
export function failedCheckSummary() {
  return {
    attempted: 0,
    published: 0,
    failed: 1,
    deferred: 0,
    skipped: 0,
    sourceErrors: 0,
    syncFailed: false,
    immediateFatal: null,
  };
}

/**
 * One monitoring cycle.
 *
 * `check` is injectable (the default is the real Telegram check) so the
 * failure path can be exercised without touching the network.
 */
export async function checkNewReleases(client = null, { check = checkTelegramChannels } = {}) {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking source channels (KokoBoko [Subdl], Rengoku [Subdl], Erai-Raws, LazySano & Arabic Anime Publisher)...`);
  try {
    // The summary of the cycle is returned so the runner can classify it.
    return await check(client);
  } catch (err) {
    // A typed fatal must NOT be swallowed here: it has to reach the runner so
    // the window aborts with a non-zero exit (F-03).
    if (err && err.isFatal === true) throw err;
    // A non-fatal error is NOT a green window: the failed-cycle summary is
    // returned so the threshold logic sees the failure (M-01).
    console.error(`🔴 check error (non-fatal): ${err.message}`);
    return failedCheckSummary();
  }
}
