// A "pure" element. Allowed to import only other "pure" elements.
// DELIBERATE VIOLATION: imports from an "app" element.
// `boundaries/element-types` must flag this.
import { bootstrap } from '../app/server';

export function compute(): string {
  return bootstrap();
}
