import { Injectable } from '@nestjs/common';

/**
 * Server-side time source. Financial posting (task 3b.1) must derive its
 * posting instant from here — never from `new Date()` directly, never from any
 * POS/browser/HTTP-supplied value — so the authoritative instant is
 * substitutable in tests and can never be client-influenced.
 */
export interface Clock {
  now(): Date;
}

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
