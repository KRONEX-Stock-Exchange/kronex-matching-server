import { Inject, Injectable } from '@nestjs/common';
import { Order, OrderStatus, OrderType, PrismaClient, TradingType } from '@prisma/client';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { OrderExecutionService } from './order-execution.service';
import { OrderAction, OrderCreatedData } from './type/order-created-data.type';
import { BuyOrder } from './type/buy.type';
import { CancelOrder } from './type/cancel.type';
import { EditOrder } from './type/edit.type';
import { SellOrder } from './type/sell.type';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class OrderService {
    constructor(
        @Inject('ORDER_SERVICE') private client: ClientProxy,
        private readonly prismaService: PrismaService,
        private readonly orderExecutionService: OrderExecutionService,
    ) {}

    async sendOrder(mqData: OrderCreatedData) {
        if (mqData.type === OrderAction.buy) {
            return await this.trade(mqData.data, 'buy');
        } else if (mqData.type === OrderAction.sell) {
            return await this.trade(mqData.data, 'sell');
        } else if (mqData.type === OrderAction.cancel) {
            return await this.cancel(mqData.data);
        } else if (mqData.type === OrderAction.edit) {
            return await this.edit(mqData.data);
        }
    }

    // 매수, 매도
    async trade(data: BuyOrder | SellOrder, tradingType: TradingType) {
        let updatedOrders: { id: number; accountId: number }[] = [];

        const account = await this.prismaService.account.findUnique({
            where: { accountNumber: data.accountNumber },
            select: { id: true },
        });

        try {
            await this.prismaService.$transaction(async (tx: PrismaClient) => {
                const accountId = account.id;

                // 시장가 주문일 경우 0원으로 통일
                if (data.orderType == OrderType.market) data.price = 0n;

                // 주문 생성
                const submitOrder = await tx.order.create({
                    data: {
                        accountId: accountId,
                        stockId: data.stockId,
                        price: data.price,
                        number: data.number,
                        orderType: data.orderType,
                        tradingType: tradingType,
                    },
                });

                // 체결 가능 주문 탐색
                if (tradingType === TradingType.buy) {
                    updatedOrders = await this.orderExecutionService.processSubmitOrder(
                        tx,
                        submitOrder,
                        BigInt((data as BuyOrder).lockedBalance),
                    );
                } else {
                    updatedOrders = await this.orderExecutionService.processSubmitOrder(
                        tx,
                        submitOrder,
                    );
                }
            });
        } catch (err) {
            console.error(err);

            // 오류시 가능 수량 잠금 해제
            if (tradingType === TradingType.sell) {
                await this.prismaService.userStock.update({
                    where: {
                        accountId_stockId: {
                            accountId: account.id,
                            stockId: data.stockId,
                        },
                    },
                    data: {
                        canNumber: { increment: data.number },
                    },
                });
            } else {
                // 오류시 매수 가능 예수금 잠금 해제
                await this.prismaService.account.update({
                    where: {
                        id: account.id,
                    },
                    data: {
                        canMoney: {
                            increment: (data as BuyOrder).lockedBalance,
                        },
                    },
                });
            }
        }

        this.client.emit('order.evented', {
            stockId: data.stockId,
            updatedOrders: updatedOrders,
        });
    }

    // 주문 정정
    async edit(data: EditOrder) {
        let order: Order;
        let updatedOrders: { id: number; accountId: number }[] = [];

        await this.prismaService.$transaction(async (tx: PrismaClient) => {
            order = await tx.order.update({
                data: {
                    price: data.price,
                },
                where: {
                    id: data.orderId,
                },
            });

            updatedOrders = await this.orderExecutionService.processSubmitOrder(tx, order);
        });

        this.client.emit('order.evented', {
            stockId: order.stockId,
            updatedOrders: updatedOrders,
        });
    }

    // 주문 취소
    async cancel(data: CancelOrder) {
        let order: Order;

        await this.prismaService.$transaction(async (tx: PrismaClient) => {
            order = await tx.order.update({
                data: {
                    status: OrderStatus.c,
                },
                where: {
                    id: data.orderId,
                },
            });

            // 매도 주문일 경우 가능수량 수정
            if (order.tradingType == 'sell') {
                await tx.userStock.update({
                    where: {
                        accountId_stockId: {
                            stockId: order.stockId,
                            accountId: order.accountId,
                        },
                    },
                    data: {
                        canNumber: {
                            increment: order.number - order.matchNumber,
                        },
                    },
                });
            }
        });

        this.client.emit('order.evented', {
            stockId: order.stockId,
            updatedOrders: [{ id: order.id, accountId: order.accountId }],
        });
    }
}
