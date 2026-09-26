import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StructuredApiExceptionFilter } from './structured-api-exception.filter.js';

function createArgumentsHost(): {
  host: ArgumentsHost;
  response: {
    setHeader: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
} {
  const json = vi.fn();
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(() => ({ json })),
    json,
  };
  const request = { headers: {} };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('StructuredApiExceptionFilter', () => {
  const filter = new StructuredApiExceptionFilter();

  it('preserves safe structured error fields and generates a request ID', () => {
    const { host, response } = createArgumentsHost();
    filter.catch(new BadRequestException({
      code: 'INVALID_CREDENTIALS',
      message: "Email yoki parol noto'g'ri",
      details: {},
    }), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INVALID_CREDENTIALS',
      message: "Email yoki parol noto'g'ri",
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      details: {},
    }));
  });

  it('does not expose internal SQL errors', () => {
    const { host, response } = createArgumentsHost();
    filter.catch(new Error('password=secret SELECT * FROM platform_users'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Ichki server xatoligi',
      details: {},
    }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('platform_users');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('secret');
  });
});
