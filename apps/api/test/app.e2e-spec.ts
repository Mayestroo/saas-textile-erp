import { INestApplication, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { AuthCoreModule } from './../src/common/auth/auth-core.module.js';
import { MasterModule } from './../src/master/master.module.js';
import { TenantModule } from './../src/tenant/tenant.module.js';

@Module({})
class TestMasterModule {}

@Module({})
class TestTenantModule {}

@Module({})
class TestAuthCoreModule {}

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(MasterModule)
      .useModule(TestMasterModule)
      .overrideModule(TenantModule)
      .useModule(TestTenantModule)
      .overrideModule(AuthCoreModule)
      .useModule(TestAuthCoreModule)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
