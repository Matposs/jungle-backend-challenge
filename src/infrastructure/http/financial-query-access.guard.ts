import { Injectable, type CanActivate } from '@nestjs/common';

@Injectable()
export class FinancialQueryAccessGuard implements CanActivate {
  canActivate(): boolean {
    // The challenge runs in a trusted environment. Authorize the authenticated caller here
    // before exposing the financial queries to untrusted clients.
    return true;
  }
}
