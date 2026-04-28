import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, PrismaClient, UserStock } from '@prisma/client';
import { getKstDate } from '../utils/get-kst-date';
import { StockLimitService } from './stock-limit.service';

@Injectable()
export class OrderUtilService {
    constructor(private stockLimitService: StockLimitService) {}

    // 체결 가능한 수량 계산
    getRemaining(order: Order) {
        return order.number - (order.matchNumber ?? 0n);
    }

    async accountMoneyIncrease(tx: PrismaClient, accountId: number, amount: bigint) {
        await tx.account.update({
            where: {
                id: accountId,
            },
            data: {
                money: {
                    increment: amount,
                },
                canMoney: {
                    increment: amount,
                },
            },
        });
    }

    async accountMoneyDecrease(tx: PrismaClient, accountId: number, amount: bigint) {
        await tx.account.update({
            where: {
                id: accountId,
            },
            data: {
                money: {
                    decrement: amount,
                },
            },
        });
    }

    // 가진 주식의 수를 증가
    async userStockIncrease(
        tx: PrismaClient,
        stockId: number,
        accountId: number,
        increaseNumber: bigint,
        userStockList: { update: number[] },
        userStocks: Map<number, UserStock>,
        buyPrice: bigint,
    ): Promise<[{ update: number[] }, Map<number, UserStock>]> {
        const userStock = userStocks.get(accountId);

        await this.accountMoneyDecrease(tx, accountId, increaseNumber * buyPrice);

        // 첫 매수
        if (!userStock) {
            userStocks.set(
                accountId,
                await tx.userStock.create({
                    data: {
                        accountId: accountId,
                        stockId: stockId,
                        number: increaseNumber,
                        canNumber: increaseNumber,
                        average: buyPrice,
                        totalBuyAmount: buyPrice * increaseNumber,
                    },
                }),
            );
        } else {
            userStocks.set(accountId, {
                ...userStock,
                number: userStock.number + increaseNumber,
                canNumber: userStock.canNumber + increaseNumber,
                average:
                    (userStock.average * userStock.number + buyPrice * increaseNumber) /
                    (userStock.number + increaseNumber),
                totalBuyAmount: userStock.totalBuyAmount + buyPrice * increaseNumber,
            });

            userStockList.update.push(accountId);
        }

        return [userStockList, userStocks];
    }

    // 가진 주식의 수를 감소
    async userStockDecrease(
        tx: PrismaClient,
        stockId: number,
        accountId: number,
        decreaseNumber: bigint,
        userStockList: { update: number[] },
        userStocks: Map<number, UserStock>,
        sellPrice: bigint,
    ): Promise<[{ update: number[] }, Map<number, UserStock>]> {
        const userStock = userStocks.get(accountId);

        await this.accountMoneyIncrease(tx, accountId, decreaseNumber * sellPrice);

        // 더 이상 보유 수량이 없을때
        if (userStock.number - decreaseNumber === 0n) {
            await tx.userStock.delete({
                where: {
                    accountId_stockId: {
                        accountId: accountId,
                        stockId: stockId,
                    },
                },
            });

            // 이전 반복에서 update 리스트에 추가된 accountId 제거
            userStockList.update = userStockList.update.filter((id) => id !== accountId);
            userStocks.delete(accountId);
        } else {
            userStocks.set(accountId, {
                ...userStock,
                number: userStock.number - decreaseNumber,
                totalBuyAmount: userStock.totalBuyAmount - userStock.average * decreaseNumber,
            });

            userStockList.update.push(accountId);
        }

        return [userStockList, userStocks];
    }

    // 체결되고 난뒤 잔여 수량 업데이트
    async orderMatchAndRemainderUpdate(
        tx: PrismaClient,
        remainderOrder: Order,
        completeOrder: Order,
    ) {
        await tx.order.update({
            where: {
                id: remainderOrder.id,
            },
            data: {
                matchNumber:
                    remainderOrder.matchNumber + (completeOrder.number - completeOrder.matchNumber),
            },
        });
    }

    // 주문 상태 업데이트
    async orderCompleteUpdate(prisma: PrismaClient, orders, number?: bigint) {
        if (orders.length == 2) {
            for (let i = 0; i < orders.length; i++) {
                await prisma.order.update({
                    where: {
                        id: orders[i].id,
                    },
                    data: {
                        status: OrderStatus.y,
                        matchNumber: orders[i].number,
                    },
                });
            }
        } else if (orders.length == 1) {
            await prisma.order.update({
                where: {
                    id: orders[0].id,
                },
                data: {
                    status: OrderStatus.y,
                    matchNumber: number,
                },
            });
        } else throw new Error('올바르지 않은 배열 크기입니다');
    }

    // 주식 가격 업데이트
    async stockPriceUpdate(tx: PrismaClient, stockId: number, updatePrice: bigint) {
        // 주식 가격 업데이트
        await tx.stock.update({
            where: { id: stockId },
            data: {
                price: updatePrice,
            },
        });

        const limits = await this.stockLimitService.getStockLimit(stockId);

        // 당일 날짜 조회 및 당일 가격 정보 조회
        const today = getKstDate(0);
        const existing = await tx.stockHistory.findUnique({
            where: { stockId_date: { stockId, date: today } },
            select: { open: true },
        });

        const stockHistory = await tx.stockHistory.upsert({
            where: {
                stockId_date: {
                    stockId: stockId,
                    date: today,
                },
            },
            create: {
                stockId: stockId,
                date: today,
                low: updatePrice,
                high: updatePrice,
                close: updatePrice,
                open: updatePrice,
                upperLimit: limits.upperLimit,
                lowerLimit: limits.lowerLimit,
            },
            update: {
                close: updatePrice,
                open: existing?.open ?? updatePrice,
            },
        });

        // 당일 저가 업데이트
        if (stockHistory.low > updatePrice) {
            await tx.stockHistory.update({
                where: {
                    stockId_date: {
                        stockId: stockId,
                        date: today,
                    },
                },
                data: {
                    low: updatePrice,
                },
            });
        }

        // 당일 고가 업데이트
        if (stockHistory.high < updatePrice) {
            await tx.stockHistory.update({
                where: {
                    stockId_date: {
                        stockId: stockId,
                        date: today,
                    },
                },
                data: {
                    high: updatePrice,
                },
            });
        }
    }

    // 주문 매칭 결과 생성
    createOrderMatch(
        submitOrder: Order,
        findOrder: Order,
        submitOrderNumber: bigint,
        findOrderNumber: bigint,
    ) {
        let orderMatch = {
            stockId: submitOrder.stockId,
            number: 0n,
            initialOrderId: findOrder.id,
            orderId: submitOrder.id,
        };

        if (submitOrderNumber < findOrderNumber) orderMatch.number = submitOrderNumber;
        else orderMatch.number = findOrderNumber;

        return orderMatch;
    }
}
