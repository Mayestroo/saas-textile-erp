import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
}

function driverError(error: unknown): PostgresError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const nested = Reflect.get(error, 'driverError');
  if (typeof nested === 'object' && nested !== null) {
    return nested as PostgresError;
  }
  return error as PostgresError;
}

export function badgePostgresCode(error: unknown): string | undefined {
  return driverError(error)?.code;
}

export function badgePostgresConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

export function badgeNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'BADGE_ASSIGNMENT_NOT_FOUND',
    message: 'Ko‘rsatilgan vaqt uchun jeton biriktiruvi topilmadi',
    details: {},
  });
}

export function badgeWorkerNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'WORKER_NOT_FOUND',
    message: 'Ishchi topilmadi',
    details: {},
  });
}

export function invalidBadgeNumber(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_BADGE_NUMBER',
    message: 'Jeton raqami bo‘sh bo‘lishi mumkin emas',
    details: {},
  });
}

export function invalidBadgeEffectiveAt(): BadRequestException {
  return new BadRequestException({
    code: 'BADGE_EFFECTIVE_AT_IN_PAST',
    message: 'Jeton amal qilish vaqti server vaqtida yoki undan keyin bo‘lishi kerak',
    details: {},
  });
}

export function invalidBadgeTimestamp(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_BADGE_TIMESTAMP',
    message: 'Jeton vaqti ISO 8601 formatida bo‘lishi kerak',
    details: {},
  });
}

export function invalidBadgeInterval(): ConflictException {
  return new ConflictException({
    code: 'BADGE_INTERVAL_CONFLICT',
    message: 'Jeton amal qilish oralig‘ida ziddiyat mavjud',
    details: {},
  });
}

export function inactiveBadgeWorker(): ConflictException {
  return new ConflictException({
    code: 'WORKER_INACTIVE',
    message: 'Faol bo‘lmagan ishchiga yangi jeton biriktirib bo‘lmaydi',
    details: {},
  });
}

export function badgeAlreadyAssigned(): ConflictException {
  return new ConflictException({
    code: 'BADGE_ALREADY_ASSIGNED',
    message: 'Jeton hozir boshqa ishchiga biriktirilgan',
    details: {},
  });
}

export function badgeAlreadyAssignedToWorker(): ConflictException {
  return new ConflictException({
    code: 'BADGE_ALREADY_ASSIGNED_TO_WORKER',
    message: 'Jeton ushbu ishchiga allaqachon biriktirilgan',
    details: {},
  });
}

export function badgeConcurrentConflict(): ConflictException {
  return new ConflictException({
    code: 'CONFLICT_BADGE_ASSIGNMENT',
    message: 'Jeton biriktiruvi boshqa amal bilan to‘qnashdi',
    details: {},
  });
}

export function futureBadgeAssignmentConflict(): ConflictException {
  return new ConflictException({
    code: 'BADGE_EFFECTIVE_TIME_CONFLICT',
    message: 'Jeton oralig‘i boshlanish vaqtidan oldin yopilishi mumkin emas',
    details: {},
  });
}
