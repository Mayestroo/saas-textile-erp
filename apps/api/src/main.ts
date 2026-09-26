import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { StructuredApiExceptionFilter } from './common/errors/structured-api-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
  }));
  app.useGlobalFilters(new StructuredApiExceptionFilter());
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
