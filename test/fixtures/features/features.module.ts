import { Body, Controller, FileTypeValidator, MaxFileSizeValidator, ParseFilePipe, Delete, Get, Headers, HttpCode, Module, Param, Patch, Post, Query, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { APP_GUARD } from '@nestjs/core';
import { AnyFilesInterceptor, FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class ListThingsQuery {
  @IsOptional() @IsString() search?: string;
  @IsInt() page!: number;
  @IsOptional() @IsString() sort?: string;
}

export class CodeParams {
  @IsString() code!: string;
  @IsString() extra!: string;
}

export class TraceHeaders {
  @IsString() 'x-trace-id'!: string;
  @IsOptional() @IsString() 'x-tenant'?: string;
}

export class UploadMeta {
  @IsString() title!: string;
  @IsOptional() @IsString() note?: string;
}

@Controller('things')
export class ThingsController {
  @Get()
  findAll(@Query() q: ListThingsQuery) {
    return [q];
  }

  @Get('by/:code')
  byCode(@Param() p: CodeParams) {
    return p;
  }

  @Get('hdr/check')
  hdr(@Headers() h: TraceHeaders) {
    return h;
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Post()
  create(@Body() b: UploadMeta) {
    return b;
  }

  @Patch(':id')
  updateThing(@Param('id') id: string) {
    return { id };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    void id;
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() b: UploadMeta) {
    return b;
  }

  @Post('verify-email')
  verifyEmail(@Body() b: UploadMeta) {
    return b;
  }

  @ApiOperation({ summary: 'My own summary' })
  @Get('custom/own')
  own() {
    return 1;
  }

  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  avatar(@UploadedFile() file: unknown, @Body() meta: UploadMeta) {
    return { file, meta };
  }

  @Post('photo')
  @UseInterceptors(FileInterceptor('photo'))
  photo(
    @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 2 * 1024 * 1024 }), new FileTypeValidator({ fileType: 'image/png' })] }))
    file: unknown,
  ) {
    return file;
  }

  @Post('optional')
  @UseInterceptors(FileInterceptor('doc'))
  optional(@UploadedFile(new ParseFilePipe({ fileIsRequired: false, validators: [new FileTypeValidator({ fileType: /pdf|word/ })] })) file: unknown) {
    return file;
  }

  @Post('gallery')
  @UseInterceptors(FilesInterceptor('photos', 5))
  gallery(@UploadedFiles() files: unknown[]) {
    return files;
  }

  @Post('docs')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cv', maxCount: 1 },
      { name: 'letters', maxCount: 3 },
    ]),
  )
  docs(@UploadedFiles() files: unknown) {
    return files;
  }

  @Post('any')
  @UseInterceptors(AnyFilesInterceptor())
  anyFiles(@UploadedFiles() files: unknown[]) {
    return files;
  }

  @Get('limited/fast')
  @Throttle({ default: { limit: 2, ttl: 1000 } })
  fast() {
    return 1;
  }

  @Get('limited/skip')
  @SkipThrottle()
  skip() {
    return 1;
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 10 }])],
  controllers: [ThingsController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class FeaturesModule {}
