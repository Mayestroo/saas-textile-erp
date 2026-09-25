import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

interface StructuredErrorResponse {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

const SAFE_HTTP_ERRORS: Readonly<Record<number, StructuredErrorResponse>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'BAD_REQUEST',
    message: 'So‘rov ma’lumotlari noto‘g‘ri',
    details: {},
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'UNAUTHORIZED',
    message: 'Tizimga kirish talab qilinadi',
    details: {},
  },
  [HttpStatus.FORBIDDEN]: {
    code: 'FORBIDDEN',
    message: 'Bu amal uchun ruxsat yo‘q',
    details: {},
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'NOT_FOUND',
    message: 'So‘ralgan ma’lumot topilmadi',
    details: {},
  },
  [HttpStatus.CONFLICT]: {
    code: 'CONFLICT',
    message: 'So‘rov mavjud ma’lumot bilan ziddiyatga ega',
    details: {},
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Urinishlar soni oshib ketdi. Keyinroq qayta urinib ko‘ring',
    details: {},
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    code: 'SERVICE_UNAVAILABLE',
    message: 'Xizmat vaqtincha ishlamayapti',
    details: {},
  },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Ichki server xatoligi',
    details: {},
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeExceptionResponse(exception: HttpException, status: number): StructuredErrorResponse {
  const response = exception.getResponse();
  if (isRecord(response)) {
    const code = Reflect.get(response, 'code');
    const message = Reflect.get(response, 'message');
    const details = Reflect.get(response, 'details');
    if (
      typeof code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(code) &&
      typeof message === 'string'
    ) {
      return {
        code,
        message,
        details: isRecord(details) ? details : {},
      };
    }
  }

  if (status === HttpStatus.BAD_REQUEST) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'So‘rov ma’lumotlari noto‘g‘ri',
      details: {},
    };
  }
  return SAFE_HTTP_ERRORS[status] ?? {
    code: 'HTTP_ERROR',
    message: 'So‘rovni bajarib bo‘lmadi',
    details: {},
  };
}

@Catch()
export class StructuredApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const safeError = exception instanceof HttpException
      ? safeExceptionResponse(exception, status)
      : SAFE_HTTP_ERRORS[HttpStatus.INTERNAL_SERVER_ERROR];
    const requestId = randomUUID();

    response.setHeader('X-Request-Id', requestId);
    response.status(status).json({ ...safeError, request_id: requestId });
  }
}
