import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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

export function postgresConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

export function modelNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'MODEL_NOT_FOUND',
    message: 'Model topilmadi',
    details: {},
  });
}

export function operationNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'OPERATION_NOT_FOUND',
    message: 'Operatsiya topilmadi',
    details: {},
  });
}

export function versionConflict(expected: string, actual: string): ConflictException {
  return new ConflictException({
    code: 'VERSION_CONFLICT',
    message: 'Ma’lumot boshqa foydalanuvchi tomonidan o‘zgartirilgan',
    details: { expected_version: expected, current_version: actual },
  });
}

export function duplicateModelName(): ConflictException {
  return new ConflictException({
    code: 'MODEL_NAME_CONFLICT',
    message: 'Faol model uchun bu nom allaqachon ishlatilgan',
    details: {},
  });
}

export function duplicateOperationName(): ConflictException {
  return new ConflictException({
    code: 'OPERATION_NAME_CONFLICT',
    message: 'Bu modeldagi faol operatsiya uchun bu nom allaqachon ishlatilgan',
    details: {},
  });
}

export function inactiveModel(): ForbiddenException {
  return new ForbiddenException({
    code: 'MODEL_INACTIVE',
    message: 'Faol bo‘lmagan model ostida operatsiya qo‘shib bo‘lmaydi',
    details: {},
  });
}

export function inactiveOperation(): ConflictException {
  return new ConflictException({
    code: 'OPERATION_INACTIVE',
    message: 'Faol bo‘lmagan operatsiya narxini rejalashtirib bo‘lmaydi',
    details: {},
  });
}

export function operationPriceConflict(message = 'Operatsiya narxi oralig‘i bilan ziddiyat mavjud'): ConflictException {
  return new ConflictException({
    code: 'OPERATION_PRICE_CONFLICT',
    message,
    details: {},
  });
}

export function operationPriceNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'OPERATION_PRICE_NOT_FOUND',
    message: 'Ko‘rsatilgan vaqt uchun operatsiya narxi topilmadi',
    details: {},
  });
}

export function effectiveFromInPast(): BadRequestException {
  return new BadRequestException({
    code: 'PRICE_EFFECTIVE_FROM_IN_PAST',
    message: 'Narx kuchga kiradigan vaqt joriy server vaqtidan oldin bo‘lishi mumkin emas',
    details: {},
  });
}

export function invalidBusinessInput(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message, details: {} });
}

export function isPostgresErrorCode(error: unknown, code: string): boolean {
  return driverError(error)?.code === code;
}
