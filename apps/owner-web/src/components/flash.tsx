/** the outcome of the last action (`?ok=` / `?error=` set by a server action); the API's own error text is shown as-is */
export function Flash({ ok, error }: { ok?: string | undefined; error?: string | undefined }) {
  if (error)
    return (
      <p className="error" role="alert" data-testid="flash-error">
        {error}
      </p>
    );
  if (ok)
    return (
      <p className="banner" role="status" data-testid="flash-ok">
        {ok}
      </p>
    );
  return null;
}
