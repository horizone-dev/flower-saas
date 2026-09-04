import { type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IDEMPOTENT_META } from './idempotent.decorator.js';

export class IdempotencyMisconfiguredError extends Error {
  constructor(offenders: string[]) {
    super(
      `@Idempotent() must not be applied to an auth / credential-producing route ` +
        `(login, MFA verify, refresh, logout, password/reset, provider-credential / secret ops). ` +
        `Offending routes:\n  - ${offenders.join('\n  - ')}`,
    );
    this.name = 'IdempotencyMisconfiguredError';
  }
}

/** Route families that must never carry `@Idempotent` (task 2.2, constraint 1). */
const FORBIDDEN =
  /(?:^|\/)(?:auth|login|logout|token|refresh|mfa|password|reset|provider-credentials|secrets?)(?:\/|$)/i;

/**
 * Bootstrap assertion: refuse to start if any mapped route both carries
 * `@Idempotent` and matches a credential-producing route family. The runtime
 * sibling of the "opt-in, and never on these" rule in the decorator docs.
 */
export function assertNoIdempotencyOnCredentialRoutes(app: INestApplication): void {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const offenders: string[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance) as object;
    const controllerPath = reflector.get<string>(PATH_METADATA, metatype) ?? '';

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      if (reflector.get(METHOD_METADATA, handler) === undefined) continue;
      if (reflector.get(IDEMPOTENT_META, handler) === undefined) continue;

      const routePath = reflector.get<string>(PATH_METADATA, handler) ?? '';
      const full = `/${controllerPath}/${routePath}`.replace(/\/+/g, '/');
      if (FORBIDDEN.test(full)) {
        offenders.push(`${metatype.name}.${methodName} [${full}]`);
      }
    }
  }

  if (offenders.length > 0) throw new IdempotencyMisconfiguredError(offenders);
}
