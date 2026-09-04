'use client';

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="content">
      <h1>Something went wrong</h1>
      <p className="error">{error.message}</p>
      <button className="btn" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
