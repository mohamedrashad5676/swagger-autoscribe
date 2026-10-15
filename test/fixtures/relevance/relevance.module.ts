import { BadGatewayException, Controller, Get, Injectable, Module, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Injectable()
export class RelService {
  bare(): void {
    throw new ServiceUnavailableException();
  }
  withMessage(): void {
    throw new ServiceUnavailableException('Search backend is down');
  }
  declaredBare(): void {
    throw new BadGatewayException();
  }
  boom(): void {
    throw new NotFoundException('shared boom');
  }
  guardedShared(id: string): void {
    if (id === 'zzz') throw new NotFoundException('shared guarded');
  }
  missing(id: string): void {
    if (!id) throw new NotFoundException('Thing not found');
  }
}

@Controller('rel')
export class RelController {
  constructor(private readonly svc: RelService) {}

  @Get('bare')
  bare() {
    this.svc.bare();
    return 1;
  }

  @Get('msg')
  withMessage(id: string) {
    this.svc.withMessage();
    this.svc.missing(id);
    return 1;
  }

  @Get('s1')
  s1(id: string) {
    this.svc.boom();
    this.svc.guardedShared(id);
    return 1;
  }

  @Get('s2')
  s2(id: string) {
    this.svc.boom();
    this.svc.guardedShared(id);
    return 1;
  }

  @Get('s3')
  s3(id: string) {
    this.svc.boom();
    this.svc.guardedShared(id);
    return 1;
  }

  @Get('own')
  own() {
    throw new NotFoundException('own direct');
  }

  @Get('declared')
  @ApiResponse({ status: 502, description: 'Upstream gave up' })
  declared() {
    this.svc.declaredBare();
    return 1;
  }
}

@Module({ controllers: [RelController], providers: [RelService] })
export class RelModule {}
