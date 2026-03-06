import { MiddlewareConsumer, Module } from '@nestjs/common';
import { OrderModule } from './order/order.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { LoggerMiddleware } from './middlewares/logger.middleware';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';

@Module({
    imports: [PrismaModule, OrderModule, ConfigModule.forRoot({ isGlobal: true })],
    controllers: [AppController],
    providers: [],
})
export class AppModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(LoggerMiddleware).forRoutes('*');
    }
}
