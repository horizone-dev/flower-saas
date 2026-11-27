import type { ReactNode } from 'react';

/** the price as a kraft hang-tag with a punched hole — the one memorable thing on the page */
export function PriceTag({
  children,
  muted = false,
  testId,
}: {
  children: ReactNode;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <span className={`price-tag${muted ? ' price-tag--muted' : ''}`} data-testid={testId}>
      <span className="price-tag__hole" aria-hidden="true" />
      <span className="price-tag__text">{children}</span>
    </span>
  );
}
