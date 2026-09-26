import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

@Injectable()
export class WorkerIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9]+$/.test(value)) {
      throw this.invalidId();
    }
    const workerId = BigInt(value);
    if (workerId < 1n || workerId > MAX_BIGINT) {
      throw this.invalidId();
    }
    return workerId.toString();
  }

  private invalidId(): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_WORKER_ID',
      message: 'Ishchi ID musbat butun son bo‘lishi kerak',
      details: {},
    });
  }
}
