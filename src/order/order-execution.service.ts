import { Injectable } from '@nestjs/common';
import {
    Account,
    Order,
    OrderStatus,
    OrderType,
    PrismaClient,
    TradingType,
    UserStock,
} from '@prisma/client';
import { OrderUtilService } from './services/order-util.service';
import { HandleMatchService } from './services/handle-match.service';

@Injectable()
export class OrderExecutionService {
    constructor(
        private readonly orderUtilService: OrderUtilService,
        private readonly handleMatchService: HandleMatchService,
    ) {}

    // 체결 가능 주문 탐색
    async findOrder(tx: PrismaClient, submitOrder: Order, tradingType: TradingType) {
        const stockId = submitOrder.stockId;
        const orderType = submitOrder.orderType;
        const price = submitOrder.price;

        let where = {
            stockId: stockId,
            tradingType: tradingType === TradingType.buy ? TradingType.sell : TradingType.buy,
            status: OrderStatus.n,
            price: {},
        };

        if (orderType === OrderType.limit) {
            if (tradingType === TradingType.buy) where.price = { lte: price };
            else if (tradingType === TradingType.sell) where.price = { gte: price };
        }

        return await tx.order.findFirst({
            where,
            orderBy: [
                { price: tradingType === TradingType.buy ? 'asc' : 'desc' },
                { createdAt: 'asc' },
            ],
            take: 1,
        });
    }

    // 체결이 끝난후 후 처리
    async finalizeTradeResult(
        tx: PrismaClient,
        stockId: number,
        userStockList: { update: number[] },
        userStocks: Map<number, UserStock>,
        createMatchList,
        nextStockPrice: bigint,
    ) {
        // 주식 가격 업데이트
        await this.orderUtilService.stockPriceUpdate(tx, stockId, nextStockPrice);

        // 체결 로그 업데이트
        await tx.orderMatch.createMany({ data: createMatchList });

        // 계좌 잔고 업데이트
        for (const accountId of [...new Set(userStockList.update)]) {
            const userStock = userStocks.get(accountId);
            await tx.userStock.update({
                where: {
                    accountId_stockId: {
                        accountId: accountId,
                        stockId: stockId,
                    },
                },
                data: {
                    number: userStock.number,
                    canNumber: userStock.canNumber,
                    average: userStock.average,
                    totalBuyAmount: userStock.totalBuyAmount,
                },
            });
        }
    }

    async processSubmitOrder(tx: PrismaClient, submitOrder: Order, lockedBalance?: bigint) {
        const stockId = submitOrder.stockId;
        const tradingType = submitOrder.tradingType;

        let totalExecutedAmount = 0n;

        let nextStockPrice: bigint;
        let createMatchList = [];

        let updatedOrders: { id: number; accountId: number }[] = [];
        updatedOrders.push({
            id: submitOrder.id,
            accountId: submitOrder.accountId,
        });

        // Update를 마지막에 한번만 하기 위해 정보를 메모리에 저장해두는 변수
        let userStockList: { update: number[] } = { update: [] }; // 업데이트 해야하는 accountId 저장
        let userStocks = new Map<number, UserStock>(); // accountId, userStocks 객체

        // 메모리에 주문 계좌의 주식 보유 현황 저장
        // 주식 보유 레코드 락
        const rs = await tx.$queryRaw<UserStock[]>`
                SELECT account_id AS accountId, stock_id AS stockId,
                       number, can_number AS canNumber, average,
                       total_buy_amount AS totalBuyAmount
                FROM user_stocks
                WHERE account_id = ${submitOrder.accountId} AND stock_id = ${stockId}
                FOR UPDATE
            `;

        userStocks.set(submitOrder.accountId, rs[0] ?? null);

        while (true) {
            // 체결할 주문 찾기
            let findOrder = await this.findOrder(tx, submitOrder, tradingType);

            if (findOrder) {
                updatedOrders.push({
                    id: findOrder.id,
                    accountId: findOrder.accountId,
                });

                // 찾은 주문 메모리에 저장
                if (!userStocks.get(findOrder.accountId)) {
                    const result = await tx.$queryRaw<UserStock[]>`
                        SELECT account_id AS accountId, stock_id AS stockId,
                               number, can_number AS canNumber, average,
                               total_buy_amount AS totalBuyAmount
                        FROM user_stocks
                        WHERE account_id = ${findOrder.accountId} AND stock_id = ${findOrder.stockId}
                        FOR UPDATE
                    `;

                    userStocks.set(findOrder.accountId, result[0] ?? null);
                }

                // 체결 가능한 수량
                const submitRemaining = this.orderUtilService.getRemaining(submitOrder);
                const findRemaining = this.orderUtilService.getRemaining(findOrder);

                // 체결
                if (submitRemaining === findRemaining) {
                    const order = [findOrder, submitOrder];
                    let executedAmount = 0n;

                    [userStockList, userStocks, executedAmount] =
                        await this.handleMatchService.handleEqualMatch(
                            tx,
                            submitOrder,
                            findOrder,
                            tradingType,
                            submitRemaining,
                            findRemaining,
                            userStockList,
                            userStocks,
                        );

                    await this.orderUtilService.orderCompleteUpdate(tx, order);

                    createMatchList.push(
                        this.orderUtilService.createOrderMatch(
                            submitOrder,
                            findOrder,
                            submitRemaining,
                            findRemaining,
                        ),
                    );

                    submitOrder.matchNumber = submitOrder.number;
                    nextStockPrice = findOrder.price;
                    totalExecutedAmount += executedAmount;

                    break;
                } else if (submitRemaining < findRemaining) {
                    const order = [submitOrder];
                    let executedAmount = 0n;

                    [userStockList, userStocks, executedAmount] =
                        await this.handleMatchService.handleRemainingMatch(
                            tx,
                            submitOrder,
                            findOrder,
                            tradingType,
                            submitRemaining,
                            userStockList,
                            userStocks,
                        );

                    await this.orderUtilService.orderCompleteUpdate(tx, order, submitOrder.number);

                    await this.orderUtilService.orderMatchAndRemainderUpdate(
                        tx,
                        findOrder,
                        submitOrder,
                    );
                    createMatchList.push(
                        this.orderUtilService.createOrderMatch(
                            submitOrder,
                            findOrder,
                            submitRemaining,
                            findRemaining,
                        ),
                    );

                    submitOrder.matchNumber = submitOrder.number;
                    nextStockPrice = findOrder.price;
                    totalExecutedAmount += executedAmount;

                    break;
                } else if (submitRemaining > findRemaining) {
                    let executedAmount = 0n;

                    [userStockList, userStocks, executedAmount] =
                        await this.handleMatchService.handlePartialMatch(
                            tx,
                            submitOrder,
                            findOrder,
                            tradingType,
                            findRemaining,
                            userStockList,
                            userStocks,
                        );

                    createMatchList.push(
                        this.orderUtilService.createOrderMatch(
                            submitOrder,
                            findOrder,
                            submitRemaining,
                            findRemaining,
                        ),
                    );
                    nextStockPrice = findOrder.price;
                    totalExecutedAmount += executedAmount;

                    submitOrder.matchNumber =
                        submitOrder.matchNumber + (findOrder.number - findOrder.matchNumber);
                }
            } else {
                // 체결할 주문이 없다면
                // 더이상 체결할 주문이 없거나 / 즉시 체결가능한 주문이 없는경우

                if (!nextStockPrice) {
                    const stock = await tx.stock.findUnique({
                        where: { id: stockId },
                        select: { price: true },
                    });

                    nextStockPrice = stock.price;
                }

                // 시장가 주문중 미체결이 있는 경우
                if (
                    submitOrder.number !== submitOrder.matchNumber &&
                    submitOrder.orderType == OrderType.market
                ) {
                    // 주문 취소 처리
                    await tx.order.update({
                        where: { id: submitOrder.id },
                        data: {
                            status: OrderStatus.c,
                        },
                    });

                    // 미체결 수량 환불
                    if (submitOrder.tradingType === TradingType.sell) {
                        await tx.userStock.update({
                            where: {
                                accountId_stockId: {
                                    accountId: submitOrder.accountId,
                                    stockId: stockId,
                                },
                            },
                            data: {
                                canNumber: {
                                    increment: submitOrder.number - submitOrder.matchNumber,
                                },
                            },
                        });
                    } else if (submitOrder.tradingType === TradingType.buy) {
                        await tx.account.update({
                            where: {
                                id: submitOrder.accountId,
                            },
                            data: {
                                canMoney: {
                                    increment: lockedBalance - totalExecutedAmount,
                                },
                            },
                        });
                    }
                } else if (
                    // 비싼 가격에 지정가 매수 주문을 한 경우 (부분 체결)
                    submitOrder.number !== submitOrder.matchNumber &&
                    submitOrder.orderType == OrderType.limit &&
                    tradingType === TradingType.buy
                ) {
                    await tx.account.update({
                        where: {
                            id: submitOrder.accountId,
                        },
                        data: {
                            canMoney: {
                                increment:
                                    lockedBalance -
                                    (totalExecutedAmount +
                                        submitOrder.price *
                                            (submitOrder.number - submitOrder.matchNumber)),
                            },
                        },
                    });
                }
                break;
            }
        }

        // 비싼 가격에 지정가 매수 주문을 한 경우 (완전 체결)
        // 잠근 금액과 실 체결 금액이 다른경우 환불
        if (
            tradingType === TradingType.buy &&
            lockedBalance !== totalExecutedAmount &&
            submitOrder.matchNumber === submitOrder.number
        ) {
            await tx.account.update({
                where: {
                    id: submitOrder.accountId,
                },
                data: {
                    canMoney: {
                        increment: lockedBalance - totalExecutedAmount,
                    },
                },
            });
        }

        // 후처리
        await this.finalizeTradeResult(
            tx,
            stockId,
            userStockList,
            userStocks,
            createMatchList,
            nextStockPrice,
        );

        return updatedOrders;
    }
}
