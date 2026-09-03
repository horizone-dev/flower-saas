import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator.js';

export class RouteCoverageError extends Error {
  constructor(routes: string[]) {
    super(
      'every controller route must declare @RequirePermission(...) or @Public(). Missing:\n' +
        routes.map((r) => `  - ${r}`).join('\n'),
    );
    this.name = 'RouteCoverageError';
  }
}

/**
 * Bootstrap assertion (Phase 1 hard gate G8): fail to start if any mapped
 * controller route carries neither `@RequirePermission(...)` nor `@Public()` —
 * the runtime sibling of the `route-must-declare-permission` lint rule.
 */
export function assertEveryRouteDeclaresIntent(app: INestApplication): void {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const offenders: string[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance) as object;
    const controllerPath = reflector.get<string>(PATH_METADATA, metatype) ?? '';
    const classPublic = reflector.get<boolean>(IS_PUBLIC_KEY, metatype) ?? false;
    const classPerm = reflector.get<string>(REQUIRED_PERMISSION_KEY, metatype);

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      if (reflector.get(METHOD_METADATA, handler) === undefined) continue; // not a route

      const isPublic = (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ?? false) || classPublic;
      const perm = reflector.get<string>(REQUIRED_PERMISSION_KEY, handler) ?? classPerm;
      if (!isPublic && !perm) {
        const routePath = reflector.get<string>(PATH_METADATA, handler) ?? '';
        offenders.push(`${metatype.name}.${methodName} [${controllerPath}/${routePath}]`);
      }
    }
  }

  if (offenders.length > 0) throw new RouteCoverageError(offenders);
}
