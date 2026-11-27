import { serverApi } from './api';
import { clearSession } from './session';

/**
 * Sign out PROPERLY: revoke the session on the server (the existing `POST /v1/auth/logout`), then delete the cookies. Deleting cookies alone
 * left the server session alive, and the plan allows only a few concurrent sessions per user — an Owner who signed in a few times could be
 * refused the next sign-in (`LIMIT_EXCEEDED`) until the old sessions expired. The revoke is best effort: whatever happens, the cookies go.
 */
export async function endSession(): Promise<void> {
  try {
    await serverApi().logout();
  } catch {
    /* an already-expired session or an unreachable API must never keep the user signed in here */
  }
  await clearSession();
}
