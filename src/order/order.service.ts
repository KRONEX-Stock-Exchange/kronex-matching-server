import { Inject, Injectable } from '@nestjs/common';
import { Order, OrderStatus, OrderType, Prisma, PrismaClient, TradingType } from '@prisma/client';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { OrderExecutionService } from './order-execution.service';
import { OrderAction, OrderCreatedData } from './type/order-created-data.type';
import { BuyOrder } from './type/buy.type';
import { CancelOrder } from './type/cancel.type';
import { EditOrder } from './type/edit.type';
import { SellOrder } from './type/sell.type';
import { ClientProxy } from '@nestjs/microservices';
import { orderSerializer } from './utils/order-serializer';

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
        let rs: {
            updatedOrders: Order[];
            nextStockPrice: bigint;
            matchedAt: Date;
            volume: number;
            matchedList: { price: number; number: number }[];
        };

        const account = await this.prismaService.account.findUnique({
            where: { accountNumber: data.accountNumber },
            select: { id: true },
        });

        if (!account) throw new Error(`Account not found: ${data.accountNumber}`);

        try {
            await this.prismaService.$transaction(
                async (tx: PrismaClient) => {
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
                            matchNumber: 0n,
                            orderType: data.orderType,
                            tradingType: tradingType,
                        },
                    });

                    // 체결 가능 주문 탐색
                    if (tradingType === TradingType.buy) {
                        rs = await this.orderExecutionService.processSubmitOrder(
                            tx,
                            submitOrder,
                            BigInt((data as BuyOrder).lockedBalance),
                        );
                    } else {
                        rs = await this.orderExecutionService.processSubmitOrder(tx, submitOrder);
                    }
                },
                { timeout: 30000 },
            );
        } catch (err) {
            console.error(err);
            console.log(account);

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

            return;
        }

        this.client.emit('order.evented', {
            type: tradingType,
            stock: {
                id: data.stockId,
                nextPrice: Number(rs.nextStockPrice),
            },
            matchedAt: rs.matchedAt,
            volume: rs.volume,
            matchedList: rs.matchedList,
            updatedOrders: orderSerializer(rs.updatedOrders),
        });
    }

    // 주문 정정
    // @TODO 에러처리 해야됨
    async edit(data: EditOrder) {
        let rs: {
            updatedOrders: Order[];
            nextStockPrice: bigint;
            matchedAt: Date;
            volume: number;
            matchedList: { price: number; number: number }[];
        };
        let order: Order;
        let isAlreadyProcessed = false;
        let prevOrderPrice = 0;

        await this.prismaService.$transaction(async (tx: PrismaClient) => {
            // 주문 락
            const [lockedOrder] = await tx.$queryRaw<Order[]>`
                SELECT
                    status, price
                FROM orders
                WHERE id = ${data.orderId}
                FOR UPDATE
            `;

            // 중복 체결 방지
            if (lockedOrder.status !== OrderStatus.n) {
                isAlreadyProcessed = true;
                return;
            }

            order = await tx.order.update({
                data: {
                    price: data.price,
                },
                where: {
                    id: data.orderId,
                },
            });

            const lockedBalance = (order.number - order.matchNumber) * order.price;

            rs = await this.orderExecutionService.processSubmitOrder(tx, order, lockedBalance);
        });

        if (isAlreadyProcessed) {
            return this.client.emit('order.error', {
                orderId: data.orderId,
                key: 'ALREADY_PROCESSED_ORDER',
            });
        }

        this.client.emit('order.evented', {
            type: 'edit',
            stock: {
                id: order.stockId,
                nextPrice: Number(rs.nextStockPrice),
            },
            matchedAt: rs.matchedAt,
            volume: rs.volume,
            matchedList: rs.matchedList,
            prevOrderPrice: prevOrderPrice,
            updatedOrders: orderSerializer(rs.updatedOrders),
        });
    }

    // 주문 취소
    async cancel(data: CancelOrder) {
        let rs = {
            updatedOrders: [],
        };
        let order: Order;
        let isAlreadyProcessed = false;

        await this.prismaService.$transaction(async (tx: PrismaClient) => {
            // 주문 락
            const [lockedOrder] = await tx.$queryRaw<Order[]>`
                SELECT
                    status
                FROM orders
                WHERE id = ${data.orderId}
                FOR UPDATE
            `;

            // 중복 체결 방지
            if (lockedOrder.status !== OrderStatus.n) {
                isAlreadyProcessed = true;
                return;
            }

            order = await tx.order.update({
                data: {
                    status: OrderStatus.c,
                },
                where: {
                    id: data.orderId,
                },
            });
            rs.updatedOrders.push(order);

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
            } else {
                await tx.account.update({
                    where: {
                        id: order.accountId,
                    },
                    data: {
                        canMoney: {
                            increment: (order.number - order.matchNumber) * order.price,
                        },
                    },
                });
            }
        });

        if (isAlreadyProcessed) {
            return this.client.emit('order.error', {
                orderId: data.orderId,
                key: 'ALREADY_PROCESSED_ORDER',
            });
        }

        this.client.emit('order.evented', {
            type: 'cancel',
            stock: {
                id: order.stockId,
                nextPrice: 0,
            },
            volume: 0,
            matchedAt: null,
            matchedList: [],
            updatedOrders: orderSerializer(rs.updatedOrders),
        });
    }
}
