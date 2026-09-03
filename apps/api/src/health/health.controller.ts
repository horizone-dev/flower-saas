import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../common/auth/public.decorator.js';
import { HealthService } from './health.service.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  @Public()
  healthz(): { status: 'ok' } {
    return this.health.health();
  }

  @Get('readyz')
  @Public()
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    const result = await this.health.readiness();
    void reply.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
