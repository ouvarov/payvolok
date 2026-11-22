import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

const UNKNOWN_CLIENT_TRACKER = 'unknown';

@Injectable()
export class DemoThrottlerGuard extends ThrottlerGuard {
  private readonly hopLogger = new Logger(DemoThrottlerGuard.name);
  private isHopCountLogged = false;

  // req.ip honours TRUST_PROXY_HOPS; entries a client writes left of the trusted hops never reach it.
  protected override getTracker(request: Request): Promise<string> {
    this.logHopCountOnce(request);

    return Promise.resolve(request.ip ?? UNKNOWN_CLIENT_TRACKER);
  }

  // TRUST_PROXY_HOPS is set from this count; the addresses themselves are personal data and stay out.
  private logHopCountOnce(request: Request): void {
    if (this.isHopCountLogged) return;

    this.isHopCountLogged = true;
    const forwardedFor = request.header('x-forwarded-for');
    const hopCount =
      forwardedFor === undefined ? 0 : forwardedFor.split(',').length;
    this.hopLogger.log(
      `First demo request carried ${hopCount} X-Forwarded-For entries`,
    );
  }
}
