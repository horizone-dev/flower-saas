'use client';

import { useActionState } from 'react';
import { enrolAction, type EnrolState } from './actions';

const INITIAL: EnrolState = { phase: 'idle' };

/**
 * Two steps: (1) "Set up" shows the QR code and the secret for manual entry, (2) the user types the CURRENT code from their app to confirm.
 * The secret lives only in this component's memory (React state) and in the markup of this response; it is never put in a URL, storage or
 * cookie, and it disappears from the state the moment the factor is confirmed.
 */
export function Enrol() {
  const [state, action, pending] = useActionState(enrolAction, INITIAL);

  return (
    <div className="stack" style={{ maxWidth: '30rem' }}>
      {state.phase === 'idle' ? (
        <form action={action} className="card stack">
          <input type="hidden" name="intent" value="start" />
          <h2>Protect your account</h2>
          <p>
            Use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy,
            1Password…). You will scan a code, then type the 6-digit number the app shows.
          </p>
          <p className="muted" data-testid="mfa-warning">
            <strong>First-time setup only.</strong> If this account already has an authenticator, do
            not continue: adding a second one can lock you out.
          </p>
          <label className="row gap">
            <input type="checkbox" name="ack" value="yes" required data-testid="mfa-ack" />
            <span>This account has no authenticator yet</span>
          </label>
          <button
            className="btn btn--primary"
            type="submit"
            disabled={pending}
            data-testid="mfa-start"
          >
            {pending ? 'Preparing…' : 'Set up authenticator'}
          </button>
        </form>
      ) : (
        <>
          <section className="card stack" aria-labelledby="mfa-step1">
            <h2 id="mfa-step1">1. Add this account to your app</h2>
            <div
              className="qr"
              data-testid="mfa-qr"
              // numbers-only SVG produced by qrSvg(): one <svg>, one <path>, no text from the secret
              dangerouslySetInnerHTML={{ __html: state.svg ?? '' }}
            />
            <p className="muted">Cannot scan? Enter this key in the app (time-based, 6 digits):</p>
            <p className="secret" data-testid="mfa-secret" translate="no">
              {state.secret}
            </p>
            <p className="muted">This key is shown once. Do not share it or save a screenshot.</p>
          </section>
          <form action={action} className="card stack" autoComplete="off">
            <input type="hidden" name="intent" value="confirm" />
            <h2>2. Confirm with a code</h2>
            <label className="field">
              <span>6-digit code from the app</span>
              <input
                name="code"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="123456"
                maxLength={7}
                required
                data-testid="mfa-code"
              />
            </label>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={pending}
              data-testid="mfa-confirm"
            >
              {pending ? 'Checking…' : 'Confirm'}
            </button>
          </form>
        </>
      )}
      {state.error ? (
        <p className="error" role="alert" data-testid="mfa-error">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
