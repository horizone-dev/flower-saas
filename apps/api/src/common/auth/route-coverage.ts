import { RequestMethod, type INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator.js';
import { PLATFORM_REALM_KEY } from './pipeline.decorators.js';

export interface MappedRoute {
  controller: string;
  handler: string;
  httpMethod: string;
  /** the `/v1`-relative path pattern, e.g. `/v1/platform/tenants/:tenantId/roles` */
  path: string;
  realm: 'tenant' | 'platform';
  isPublic: boolean;
  permission: string | undefined;
}

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

const joinPath = (...parts: string[]): string =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter((s) => s.length > 0)
    .join('/');

/**
 * Every mapped controller route, with its realm / public flag / permission —
 * used by the cross-tenant probe suite (task 1.13) to assert that no non-public
 * route escapes a probe, and by tests that need the route table.
 */
export function enumerateRoutes(app: INestApplication): MappedRoute[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const routes: MappedRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance) as object;
    const controllerPath = reflector.get<string>(PATH_METADATA, metatype) ?? '';
    const classPublic = reflector.get<boolean>(IS_PUBLIC_KEY, metatype) ?? false;
    const classPerm = reflector.get<string>(REQUIRED_PERMISSION_KEY, metatype);
    const classRealm = reflector.get<boolean>(PLATFORM_REALM_KEY, metatype) ?? false;

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      const method = reflector.get<number>(METHOD_METADATA, handler);
      if (method === undefined) continue;

      const handlerPath = reflector.get<string>(PATH_METADATA, handler) ?? '';
      const handlerRealm = reflector.get<boolean>(PLATFORM_REALM_KEY, handler) ?? false;
      routes.push({
        controller: metatype.name,
        handler: methodName,
        httpMethod: METHOD_NAME[method] ?? String(method),
        path: joinPath('v1', controllerPath, handlerPath),
        realm: classRealm || handlerRealm ? 'platform' : 'tenant',
        isPublic: classPublic || (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ?? false),
        permission: reflector.get<string>(REQUIRED_PERMISSION_KEY, handler) ?? classPerm,
      });
    }
  }
  return routes;
}

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
