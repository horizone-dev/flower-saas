import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cn, tokens, Button } from './index.js';

describe('@flower/ui — cn', () => {
  it('joins truthy class values and drops falsy ones', () => {
    expect(cn('a', false, null, undefined, 'b', ['c', ['d']])).toBe('a b c d');
    expect(cn(0, 'x')).toBe('0 x');
  });
});

describe('@flower/ui — tokens', () => {
  it('exposes the brand ramp and a spacing scale', () => {
    expect(tokens.color.brand[500]).toMatch(/^#/);
    expect(tokens.space(4)).toBe('1rem');
    expect(tokens.radius.card).toBe('0.75rem');
  });
});

describe('@flower/ui — Button', () => {
  it('renders a button with the variant class and forwards props', () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary" type="submit" data-testid="go">
        Save
      </Button>,
    );
    expect(html).toContain('class="fl-btn fl-btn--secondary"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-testid="go"');
    expect(html).toContain('Save');
  });
});
