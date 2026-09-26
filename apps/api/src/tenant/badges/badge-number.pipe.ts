import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class BadgeNumberPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string') {
      throw this.invalidBadge();
    }
    const badgeNumber = value.trim();
    if (!badgeNumber) {
      throw this.invalidBadge();
    }
    return badgeNumber;
  }

  private invalidBadge(): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_BADGE_NUMBER',
      message: 'Jeton raqami bo‘sh bo‘lishi mumkin emas',
      details: {},
    });
  }
}
