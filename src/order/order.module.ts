import { Module } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderExecutionService } from './order-execution.service';
import { OrderUtilService } from './services/order-util.service';
import { HandleMatchService } from './services/handle-match.service';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OrderMqController } from './order.mq.controller';
import { ConfigService } from '@nestjs/config';
import { StockLimitService } from './services/stock-limit.service';

@Module({
    imports: [
        ClientsModule.registerAsync([
            {
                name: 'ORDER_SERVICE',
                inject: [ConfigService],
                useFactory: (configService: ConfigService) => ({
                    transport: Transport.RMQ,
                    options: {
                        urls: [configService.get<string>('RABBITMQ_URL')],
                        queue: 'order_event_queue',
                        queueOptions: {
                            durable: true,
                        },
                        persistent: true,
                    },
                }),
            },
        ]),
    ],
    controllers: [OrderMqController],
    providers: [
        OrderService,
        OrderExecutionService,
        OrderUtilService,
        HandleMatchService,
        StockLimitService,
    ],
})
export class OrderModule {}
