import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { getContext, requireContext } from './context.als.js';
import type { RequestContext } from './request-context.js';

/**
 * Inject the immutable `RequestContext` into a controller handler:
 *
 *   @Get() list(@Ctx() ctx: RequestContext) { … }
 *
 * Throws if no context is active (a route reached without the pipeline — a bug).
 */
export const Ctx = createParamDecorator(
  (_data: unknown, _executionContext: ExecutionContext): RequestContext => requireContext('@Ctx()'),
);

export { getContext, requireContext };
