import 'reflect-metadata';
import * as vm from 'node:vm';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { Matches, IsString } from 'class-validator';
import { createApp } from './helpers';
import { buildDocument } from '../src';

class RegisterDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_.-]+$/)
  user_name!: string;
  @IsString()
  @Matches(/^\$'&\$1$/)
  tricky!: string;
}
@Controller('auth')
class AuthController {
  @Post('register')
  register(@Body() _b: RegisterDto): void {}
}
@Module({ controllers: [AuthController] })
class M {}

describe('swagger-ui-init injection safety', () => {
  it('generated document survives String.replace injection (no $-patterns)', async () => {
    const app = await createApp(M);
    const doc: any = buildDocument(app, { logger: false });
    await app.close();
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/\$[`'&$]/);
    // exactly what @nestjs/swagger does: template.replace(placeholder, <string>)
    const tpl = 'window.__o = <% swaggerOptions %>;';
    const out = tpl.replace('<% swaggerOptions %>', JSON.stringify({ swaggerDoc: doc }));
    expect(() => new vm.Script(out)).not.toThrow();
    const ctx: any = { window: {} };
    vm.runInNewContext(out, ctx);
    expect(JSON.stringify(ctx.window.__o.swaggerDoc)).toBe(text);
  });
});
