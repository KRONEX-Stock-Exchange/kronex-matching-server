import { Test, TestingModule } from '@nestjs/testing';
import { Order, OrderStatus, OrderType, PrismaClient, TradingType, UserStock } from '@prisma/client';
import { OrderUtilService } from './order-util.service';
import { StockLimitService } from './stock-limit.service';

// ─────────────────────────────────────────────
// 헬퍼 팩토리
// ─────────────────────────────────────────────
const makeOrder = (overrides: Partial<Order> = {}): Order => ({
    id: 1,
    accountId: 1,
    stockId: 1,
    price: 1000n,
    number: 10n,
    matchNumber: 0n,
    orderType: OrderType.limit,
    tradingType: TradingType.buy,
    status: OrderStatus.n,
    createdAt: new Date(),
    ...overrides,
});

const makeUserStock = (overrides: Partial<UserStock> = {}): UserStock => ({
    accountId: 1,
    stockId: 1,
    number: 100n,
    canNumber: 90n,
    average: 1000n,
    totalBuyAmount: 100000n,
    ...overrides,
});

// ─────────────────────────────────────────────
// Mock PrismaClient tx
// ─────────────────────────────────────────────
const makeMockTx = () =>
    ({
        account: {
            update: jest.fn().mockResolvedValue({}),
        },
        order: {
            update: jest.fn().mockResolvedValue({}),
        },
        userStock: {
            create: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({}),
            upsert: jest.fn(),
        },
        stock: {
            update: jest.fn().mockResolvedValue({}),
        },
        stockHistory: {
            upsert: jest.fn().mockResolvedValue({ low: 1000n, high: 1000n }),
            update: jest.fn().mockResolvedValue({}),
        },
    }) as unknown as PrismaClient;

// ─────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────
describe('OrderUtilService', () => {
    let service: OrderUtilService;
    let mockStockLimitService: jest.Mocked<Partial<StockLimitService>>;

    beforeEach(async () => {
        mockStockLimitService = {
            getStockLimit: jest.fn().mockResolvedValue({ upperLimit: 2000, lowerLimit: 500 }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrderUtilService,
                { provide: StockLimitService, useValue: mockStockLimitService },
            ],
        }).compile();

        service = module.get<OrderUtilService>(OrderUtilService);
    });

    // ─── getRemaining ───────────────────────────────────────────────────────────
    describe('getRemaining', () => {
        it('matchNumber가 0일 때 number 전체를 반환한다', () => {
            const order = makeOrder({ number: 10n, matchNumber: 0n });
            expect(service.getRemaining(order)).toBe(10n);
        });

        it('matchNumber가 있을 때 number - matchNumber를 반환한다', () => {
            const order = makeOrder({ number: 10n, matchNumber: 3n });
            expect(service.getRemaining(order)).toBe(7n);
        });

        it('matchNumber가 null일 때 number 전체를 반환한다', () => {
            const order = makeOrder({ number: 10n, matchNumber: null });
            expect(service.getRemaining(order)).toBe(10n);
        });

        it('완전 체결(matchNumber === number)이면 0을 반환한다', () => {
            const order = makeOrder({ number: 10n, matchNumber: 10n });
            expect(service.getRemaining(order)).toBe(0n);
        });
    });

    // ─── accountMoneyIncrease / accountMoneyDecrease ────────────────────────────
    describe('accountMoneyIncrease', () => {
        it('account.update increment로 잔고를 증가시킨다', async () => {
            const tx = makeMockTx();
            await service.accountMoneyIncrease(tx, 1, 5000n);
            expect(tx.account.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: { money: { increment: 5000n } },
            });
        });
    });

    describe('accountMoneyDecrease', () => {
        it('account.update decrement로 잔고를 감소시킨다', async () => {
            const tx = makeMockTx();
            await service.accountMoneyDecrease(tx, 2, 3000n);
            expect(tx.account.update).toHaveBeenCalledWith({
                where: { id: 2 },
                data: { money: { decrement: 3000n } },
            });
        });
    });

    // ─── userStockIncrease ──────────────────────────────────────────────────────
    describe('userStockIncrease', () => {
        it('처음 매수 - userStock 레코드가 없으면 create 호출', async () => {
            const tx = makeMockTx();
            const createdStock = makeUserStock({ accountId: 1, number: 5n, canNumber: 5n, average: 800n, totalBuyAmount: 4000n });
            (tx.userStock.create as jest.Mock).mockResolvedValue(createdStock);

            const userStocks = new Map<number, UserStock>();
            const userStockList = { update: [] };

            const [resultList, resultMap] = await service.userStockIncrease(
                tx, 1, 1, 5n, userStockList, userStocks, 800n,
            );

            expect(tx.userStock.create).toHaveBeenCalledWith({
                data: {
                    accountId: 1,
                    stockId: 1,
                    number: 5n,
                    canNumber: 5n,
                    average: 800n,
                    totalBuyAmount: 4000n,
                },
            });
            expect(resultMap.get(1)).toEqual(createdStock);
            expect(resultList.update).not.toContain(1);
        });

        it('추가 매수 - 기존 userStock이 있으면 메모리 업데이트 및 update 목록에 추가', async () => {
            const tx = makeMockTx();
            const existing = makeUserStock({ accountId: 1, number: 10n, canNumber: 8n, average: 1000n, totalBuyAmount: 10000n });
            const userStocks = new Map<number, UserStock>([[1, existing]]);
            const userStockList = { update: [] };

            const [resultList, resultMap] = await service.userStockIncrease(
                tx, 1, 1, 5n, userStockList, userStocks, 800n,
            );

            const updated = resultMap.get(1);
            expect(updated.number).toBe(15n);
            expect(updated.canNumber).toBe(13n);
            // average = (1000 * 10 + 800 * 5) / 15 = 14000 / 15 = 933n (BigInt floor)
            expect(updated.average).toBe(933n);
            expect(updated.totalBuyAmount).toBe(14000n);
            expect(resultList.update).toContain(1);
            expect(tx.userStock.create).not.toHaveBeenCalled();
        });

        it('매수 시 account 잔고를 차감한다 (accountMoneyDecrease)', async () => {
            const tx = makeMockTx();
            (tx.userStock.create as jest.Mock).mockResolvedValue(makeUserStock());
            const userStocks = new Map<number, UserStock>();

            await service.userStockIncrease(tx, 1, 1, 10n, { update: [] }, userStocks, 500n);

            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { money: { decrement: 5000n } }, // 10 * 500
                }),
            );
        });
    });

    // ─── userStockDecrease ──────────────────────────────────────────────────────
    describe('userStockDecrease', () => {
        it('일부 매도 - 잔여 수량이 있으면 메모리 업데이트 및 update 목록에 추가', async () => {
            const tx = makeMockTx();
            const existing = makeUserStock({ accountId: 1, number: 10n, canNumber: 8n, average: 1000n, totalBuyAmount: 10000n });
            const userStocks = new Map<number, UserStock>([[1, existing]]);
            const userStockList = { update: [] };

            const [resultList, resultMap] = await service.userStockDecrease(
                tx, 1, 1, 3n, userStockList, userStocks, 1100n,
            );

            const updated = resultMap.get(1);
            expect(updated.number).toBe(7n);
            expect(updated.totalBuyAmount).toBe(7000n); // 10000 - average(1000) * 3
            expect(resultList.update).toContain(1);
            expect(tx.userStock.delete).not.toHaveBeenCalled();
        });

        it('전량 매도 - 수량이 0이 되면 delete 호출 및 update 목록에서 제거', async () => {
            const tx = makeMockTx();
            const existing = makeUserStock({ accountId: 1, number: 5n, canNumber: 5n, average: 1000n, totalBuyAmount: 5000n });
            const userStocks = new Map<number, UserStock>([[1, existing]]);
            const userStockList = { update: [1] }; // 이전 반복에서 추가됐다고 가정

            const [resultList, resultMap] = await service.userStockDecrease(
                tx, 1, 1, 5n, userStockList, userStocks, 1200n,
            );

            expect(tx.userStock.delete).toHaveBeenCalledWith({
                where: { accountId_stockId: { accountId: 1, stockId: 1 } },
            });
            expect(resultMap.has(1)).toBe(false);
            expect(resultList.update).not.toContain(1);
        });

        it('매도 시 account 잔고를 증가시킨다 (accountMoneyIncrease)', async () => {
            const tx = makeMockTx();
            const existing = makeUserStock({ accountId: 1, number: 10n });
            const userStocks = new Map<number, UserStock>([[1, existing]]);

            await service.userStockDecrease(tx, 1, 1, 4n, { update: [] }, userStocks, 1100n);

            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { money: { increment: 4400n } }, // 4 * 1100
                }),
            );
        });
    });

    // ─── createOrderMatch ───────────────────────────────────────────────────────
    describe('createOrderMatch', () => {
        it('submitOrderNumber < findOrderNumber → number = submitOrderNumber', () => {
            const submitOrder = makeOrder({ id: 1, stockId: 1 });
            const findOrder = makeOrder({ id: 2 });

            const result = service.createOrderMatch(submitOrder, findOrder, 3n, 10n);

            expect(result.number).toBe(3n);
            expect(result.orderId).toBe(1);
            expect(result.initialOrderId).toBe(2);
            expect(result.stockId).toBe(1);
        });

        it('submitOrderNumber >= findOrderNumber → number = findOrderNumber', () => {
            const submitOrder = makeOrder({ id: 1, stockId: 1 });
            const findOrder = makeOrder({ id: 2 });

            const result = service.createOrderMatch(submitOrder, findOrder, 10n, 5n);

            expect(result.number).toBe(5n);
        });

        it('submitOrderNumber === findOrderNumber → number = findOrderNumber', () => {
            const submitOrder = makeOrder({ id: 1, stockId: 1 });
            const findOrder = makeOrder({ id: 2 });

            const result = service.createOrderMatch(submitOrder, findOrder, 7n, 7n);

            expect(result.number).toBe(7n);
        });
    });

    // ─── orderCompleteUpdate ────────────────────────────────────────────────────
    describe('orderCompleteUpdate', () => {
        it('주문 2개 - 모두 status=y, matchNumber=number로 업데이트', async () => {
            const tx = makeMockTx();
            const order1 = makeOrder({ id: 1, number: 10n });
            const order2 = makeOrder({ id: 2, number: 5n });

            await service.orderCompleteUpdate(tx, [order1, order2]);

            expect(tx.order.update).toHaveBeenCalledTimes(2);
            expect(tx.order.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: { status: OrderStatus.y, matchNumber: 10n },
            });
            expect(tx.order.update).toHaveBeenCalledWith({
                where: { id: 2 },
                data: { status: OrderStatus.y, matchNumber: 5n },
            });
        });

        it('주문 1개 - status=y, matchNumber=number로 업데이트', async () => {
            const txWithOrder = {
                ...makeMockTx(),
                order: { update: jest.fn().mockResolvedValue({}) },
            } as unknown as PrismaClient;
            const order = makeOrder({ id: 1, number: 10n });

            await service.orderCompleteUpdate(txWithOrder, [order], 10n);

            expect(txWithOrder.order.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: { status: OrderStatus.y, matchNumber: 10n },
            });
        });

        it('배열 크기가 0 또는 3 이상이면 에러를 던진다', async () => {
            const txWithOrder = {
                ...makeMockTx(),
                order: { update: jest.fn().mockResolvedValue({}) },
            } as unknown as PrismaClient;

            await expect(service.orderCompleteUpdate(txWithOrder, [])).rejects.toThrow();
        });
    });

    // ─── orderMatchAndRemainderUpdate ───────────────────────────────────────────
    describe('orderMatchAndRemainderUpdate', () => {
        it('remainderOrder의 matchNumber를 completeOrder 체결 수량만큼 증가시킨다', async () => {
            const txWithOrder = {
                ...makeMockTx(),
                order: { update: jest.fn().mockResolvedValue({}) },
            } as unknown as PrismaClient;

            const remainderOrder = makeOrder({ id: 10, matchNumber: 5n });
            const completeOrder = makeOrder({ id: 20, number: 10n, matchNumber: 3n }); // 잔여 = 7

            await service.orderMatchAndRemainderUpdate(txWithOrder, remainderOrder, completeOrder);

            expect(txWithOrder.order.update).toHaveBeenCalledWith({
                where: { id: 10 },
                data: { matchNumber: 12n }, // 5 + (10 - 3)
            });
        });
    });
});
