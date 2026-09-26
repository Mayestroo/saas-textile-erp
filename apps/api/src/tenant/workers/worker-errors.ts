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

export function workerPostgresConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

export function workerPostgresCode(error: unknown): string | undefined {
  return driverError(error)?.code;
}

export function workerNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'WORKER_NOT_FOUND',
    message: 'Ishchi topilmadi',
    details: {},
  });
}

export function invalidWorkerName(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_WORKER_NAME',
    message: 'Ishchi ismi bo‘sh bo‘lishi mumkin emas',
    details: {},
  });
}

export function invalidWorkerVersion(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_EXPECTED_VERSION',
    message: 'Kutilgan versiya musbat BIGINT satr bo‘lishi kerak',
    details: {},
  });
}

export function emptyWorkerUpdate(): BadRequestException {
  return new BadRequestException({
    code: 'EMPTY_UPDATE',
    message: 'O‘zgartiriladigan maydon yuborilmadi',
    details: {},
  });
}

export function workerVersionConflict(expected: string, current: string): ConflictException {
  return new ConflictException({
    code: 'VERSION_CONFLICT',
    message: 'Ma’lumot boshqa foydalanuvchi tomonidan o‘zgartirilgan',
    details: { expected_version: expected, current_version: current },
  });
}

export function workerInputConflict(): ConflictException {
  return new ConflictException({
    code: 'WORKER_DATA_CONFLICT',
    message: 'Ishchi ma’lumotida ziddiyat mavjud',
    details: {},
  });
}
