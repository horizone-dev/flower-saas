import { Injectable } from '@nestjs/common';
import {
  PaymentWebhookRepository,
  type IncomingWebhookRequest,
} from './payment-webhook.repository.js';

/** Thin pass-through, mirroring `PaymentService`/`PaymentAttemptService`. */
@Injectable()
export class PaymentWebhookService {
  constructor(private readonly repo: PaymentWebhookRepository) {}

  handle(request: IncomingWebhookRequest): Promise<void> {
    return this.repo.handle(request);
  }
}
