import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtGuard, PermissionsGuard } from './common/guards';
import { OrdersController } from './orders/orders.controller';
import { ReportsController } from './reports/reports';
import { DeepController, DeepService } from './helpers/deep.service';
import { InternalController, UsersController } from './users/users.controller';
import { UsersRepository, UsersService } from './users/users.service';

@Module({
  controllers: [UsersController, InternalController, OrdersController, ReportsController, DeepController],
  providers: [
    UsersService,
    DeepService,
    UsersRepository,
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
