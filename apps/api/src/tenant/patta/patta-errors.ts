import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export function pattaBadRequest(code: string, message: string, details: object = {}): BadRequestException {
  return new BadRequestException({ code, message, details });
}

export function pattaConflict(code: string, message: string, details: object = {}): ConflictException {
  return new ConflictException({ code, message, details });
}

export function pattaForbidden(code: string, message: string): ForbiddenException {
  return new ForbiddenException({ code, message, details: {} });
}

export function pattaNotFound(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message, details: {} });
}

export function pattaTemplateNotFound(): NotFoundException {
  return pattaNotFound('PATTA_TEMPLATE_NOT_FOUND', 'Patta qolipi topilmadi');
}

export function pattaModelHasNoOperations(): ConflictException {
  return pattaConflict(
    'PATTA_MODEL_HAS_NO_OPERATIONS',
    'Modelda faol operatsiyalar yo‘q',
  );
}

export function pattaModelInactive(): ForbiddenException {
  return pattaForbidden('MODEL_INACTIVE', 'Faol bo‘lmagan model uchun Patta yaratib bo‘lmaydi');
}

export function pattaTemplateInactive(): ConflictException {
  return pattaConflict('PATTA_TEMPLATE_INACTIVE', 'Faol bo‘lmagan Patta qolipidan foydalanib bo‘lmaydi');
}

export function pattaTemplateNameConflict(): ConflictException {
  return pattaConflict(
    'PATTA_TEMPLATE_NAME_CONFLICT',
    'Faol Patta qolipi uchun bu nom allaqachon ishlatilgan',
  );
}

export function pattaVersionConflict(expected: string, actual: string): ConflictException {
  return pattaConflict(
    'VERSION_CONFLICT',
    'Ma’lumot boshqa foydalanuvchi tomonidan o‘zgartirilgan',
    { expected_version: expected, current_version: actual },
  );
}

export function pattaNumberSequenceUnavailable(): ConflictException {
  return pattaConflict(
    'PATTA_NUMBER_SEQUENCE_UNAVAILABLE',
    'Patta raqamlar ketma-ketligi boshlang‘ich holatga keltirilmagan',
  );
}

export function pattaNumberRangeExhausted(): ConflictException {
  return pattaConflict('PATTA_NUMBER_RANGE_EXHAUSTED', 'Patta raqamlar oralig‘i tugagan');
}

export function pattaNumberRangeConflict(): ConflictException {
  return pattaConflict('PATTA_NUMBER_RANGE_CONFLICT', 'Patta raqamlar oralig‘ida ziddiyat aniqlandi');
}

export function pattaMaxActiveBlocksReached(): ConflictException {
  return pattaConflict(
    'PATTA_MAX_ACTIVE_BLOCKS_REACHED',
    'Qurilmada faol Patta raqam bloklari soni chegaraga yetgan',
  );
}

export function pattaNumberBlockNotFound(): NotFoundException {
  return pattaNotFound('PATTA_NUMBER_BLOCK_NOT_FOUND', 'Patta raqam bloki topilmadi');
}

export function pattaNumberBlockDeviceMismatch(): ForbiddenException {
  return pattaForbidden('PATTA_NUMBER_BLOCK_DEVICE_MISMATCH', 'Raqam bloki bu qurilmaga tegishli emas');
}

export function pattaNumberBlockTerminal(): ConflictException {
  return pattaConflict('PATTA_NUMBER_BLOCK_TERMINAL', 'Yakunlangan yoki bekor qilingan raqam blokini o‘zgartirib bo‘lmaydi');
}

export function pattaNumberBlockUsageInvalid(code: string, message: string): BadRequestException {
  return pattaBadRequest(code, message);
}

export function pattaNumberOutsideBlock(): ConflictException {
  return pattaConflict('PATTA_NUMBER_OUTSIDE_BLOCK', 'Patta raqami ajratilgan blok oralig‘ida emas');
}

export function pattaTemplateModelMismatch(): ConflictException {
  return pattaConflict('PATTA_TEMPLATE_MODEL_MISMATCH', 'Patta qolipi tanlangan modelga mos emas');
}

export function pattaAlreadyExists(): ConflictException {
  return pattaConflict('PATTA_ALREADY_EXISTS', 'Bu partiya va Patta raqami bilan yozuv mavjud');
}

export function pattaRecordNotFound(): NotFoundException {
  return pattaNotFound('PATTA_NOT_FOUND', 'Patta hisob yozuvi topilmadi');
}

export function pattaBatchSizeInvalid(maximum: number): BadRequestException {
  return pattaBadRequest(
    'PATTA_BATCH_SIZE_INVALID',
    `Patta soni 1 dan ${maximum} gacha bo‘lishi kerak`,
    { maximum_count: maximum },
  );
}

export function pattaNumberInvalid(): BadRequestException {
  return pattaBadRequest('INVALID_PATTA_NUMBER', 'Patta raqami musbat BIGINT decimal matn bo‘lishi kerak');
}

export function pattaDateRangeInvalid(): BadRequestException {
  return pattaBadRequest('INVALID_CREATED_AT_RANGE', 'Yaratilgan vaqt oralig‘i noto‘g‘ri');
}
