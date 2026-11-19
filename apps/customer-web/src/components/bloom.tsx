import { bloomSpec } from '@/lib/bloom';

/** the placeholder artwork tile for a product (decorative: the product name is always next to it) */
export function Bloom({ id }: { id: string }) {
  const { petals, rotation, palette } = bloomSpec(id);
  const step = 360 / petals;
  return (
    <svg
      className="bloom"
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      style={{ overflow: 'visible' }}
    >
      {/* oversized so the ground colour fills any tile shape while the whole flower stays in view */}
      <rect x="-300" y="-300" width="700" height="700" fill={palette.ground} />
      <path
        d="M50 96 C48 76 52 64 50 52"
        stroke="#2F6B4F"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M50 82 C40 80 34 72 33 66 C42 66 48 72 50 82Z" fill="#2F6B4F" />
      <g transform={`rotate(${rotation} 50 40)`}>
        {Array.from({ length: petals }, (_, i) => (
          <ellipse
            key={i}
            cx="50"
            cy="22"
            rx="9"
            ry="17"
            transform={`rotate(${i * step} 50 40)`}
            fill={i % 2 === 0 ? palette.petal : palette.petalDeep}
            fillOpacity={i % 2 === 0 ? 1 : 0.85}
          />
        ))}
        <circle cx="50" cy="40" r="6.5" fill={palette.heart} />
      </g>
    </svg>
  );
}
