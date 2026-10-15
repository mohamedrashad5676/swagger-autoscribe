import { Controller, Get, Module } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { EventPattern, GrpcMethod, MessagePattern, Payload } from '@nestjs/microservices';
import { IsString } from 'class-validator';

export class ChatMessage {
  @IsString() room!: string;
  @IsString() text!: string;
}

export class OrderPlaced {
  @IsString() orderId!: string;
}

@WebSocketGateway({ namespace: 'chat', path: '/ws' })
export class ChatGateway {
  @SubscribeMessage('message')
  onMessage(@MessageBody() body: ChatMessage, @ConnectedSocket() client: unknown) {
    return { body, client };
  }

  @SubscribeMessage('ping')
  onPing() {
    return 'pong';
  }
}

@Controller('orders')
export class OrdersController {
  @Get()
  list() {
    return [];
  }

  @MessagePattern('orders.get')
  get(@Payload() id: string) {
    return id;
  }

  @EventPattern('orders.placed')
  placed(@Payload() data: OrderPlaced) {
    return data;
  }

  @GrpcMethod('OrdersService', 'Find')
  find(data: OrderPlaced) {
    return data;
  }
}

@Module({ controllers: [OrdersController], providers: [ChatGateway] })
export class AsyncModule {}
