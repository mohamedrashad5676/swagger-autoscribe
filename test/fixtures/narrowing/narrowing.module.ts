import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException } from '@nestjs/common';

function check(kind: string): void {
  if (kind === 'a') throw new NotFoundException('A missing');
  if (kind === 'b') throw new ConflictException('B conflict');
}

function relay(kind: string): void {
  check(kind);
}

function gated(mode: string, kind: string): void {
  if (mode === 'strict') check(kind);
}

function complex(kind: string, flag: boolean): void {
  if ((kind === 'a' || kind === 'b') && !flag) throw new ConflictException('complex hit');
}

function reassigned(kind: string): void {
  kind = 'a';
  if (kind === 'b') throw new ForbiddenException('B forbidden');
}

@Injectable()
export class NarrowService {
  helper(kind: string): void {
    if (kind === 'a') throw new NotFoundException('svc A');
    if (kind === 'b') throw new ConflictException('svc B');
    throw new BadRequestException('svc other');
  }
  gated(flag: boolean): void {
    if (flag) throw new ForbiddenException('flagged');
  }
}

@Controller('n')
export class NarrowController {
  constructor(private readonly svc: NarrowService) {}

  @Get('a')
  onlyA() {
    check('a');
    return 1;
  }

  @Get('b')
  onlyB() {
    this.svc.helper('b');
    return 1;
  }

  @Get('both')
  both() {
    check('a');
    check('b');
    return 1;
  }

  @Get('unknown')
  unknown(kind: string) {
    check(kind);
    return 1;
  }

  @Get('relay')
  viaRelay() {
    relay('b');
    return 1;
  }

  @Get('reassigned')
  viaReassigned() {
    reassigned('b');
    return 1;
  }

  @Get('gated-off')
  gatedOff() {
    gated('lenient', 'a');
    return 1;
  }

  @Get('gated-on')
  gatedOn() {
    gated('strict', 'a');
    return 1;
  }

  @Get('complex-hit')
  complexHit() {
    complex('b', false);
    return 1;
  }

  @Get('complex-miss')
  complexMiss() {
    complex('c', false);
    complex('a', true);
    return 1;
  }

  @Get('flag')
  flagOff() {
    this.svc.gated(false);
    return 1;
  }

  @Get('flagon')
  flagOn() {
    this.svc.gated(true);
    return 1;
  }
}

@Module({ controllers: [NarrowController], providers: [NarrowService] })
export class NarrowModule {}
