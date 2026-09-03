import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as not requiring authentication / a permission. The guard pipeline
 * (Phase 1) reads this metadata; the `route-must-declare-permission` lint rule
 * treats a route with `@Public()` as having declared its intent.
 */
export const IS_PUBLIC_KEY = 'flower:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
